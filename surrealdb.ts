import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as kubernetes from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface SurrealDbTiKvOutputs {
  clusterName: pulumi.Output<string>;
  kubeconfig: pulumi.Output<any>;
  surrealdbEndpoint: pulumi.Output<string>;
  tikvPdEndpoint: string;
}

export const setupSurrealdb = async (vpc: sst.aws.Vpc): Promise<SurrealDbTiKvOutputs> => {
  // 1. Dedicated IAM Role for EKS Managed Node Groups with EBS CSI permissions
  const nodeRole = new aws.iam.Role("surrealdb-eks-node-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "ec2.amazonaws.com",
    }),
  });

  const managedPolicies = [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
  ];

  managedPolicies.forEach((policyArn, idx) => {
    new aws.iam.RolePolicyAttachment(`surrealdb-node-policy-${idx}`, {
      role: nodeRole.name,
      policyArn,
    });
  });

  // 2. EKS Cluster with OIDC Provider enabled for EBS CSI Driver
  const cluster = new eks.Cluster("SurrealDBCluster", {
    vpcId: vpc.id,
    publicSubnetIds: vpc.publicSubnets,
    privateSubnetIds: vpc.privateSubnets,
    instanceRoles: [nodeRole],
    createOidcProvider: true,
    version: "1.30",
    instanceType: "t3.large",
    desiredCapacity: 2,
    minSize: 2,
    maxSize: 3,
    storageClasses: {
      gp3: {
        type: "gp3",
        default: true,
        allowVolumeExpansion: true,
      },
    },
    skipDefaultNodeGroup: false,
  });

  // 3. AWS EBS CSI Driver Addon (required for PD & TiKV PersistentVolumeClaims)
  const ebsCsiDriverAddon = new eks.Addon("aws-ebs-csi-driver", {
    cluster: cluster,
    addonName: "aws-ebs-csi-driver",
    serviceAccountRoleArn: nodeRole.arn,
  });

  // 4. Dedicated Managed Node Group for Placement Driver (PD)
  const pdNodeGroup = new eks.ManagedNodeGroup("pd-nodegroup", {
    cluster: cluster,
    nodeGroupName: "pd-nodes",
    instanceTypes: ["t4g.medium"],
    amiType: "AL2023_ARM_64_STANDARD",
    scalingConfig: {
      desiredSize: 3,
      minSize: 3,
      maxSize: 3,
    },
    labels: { dedicated: "pd" },
    taints: [{ key: "dedicated", value: "pd", effect: "NO_SCHEDULE" }],
    subnetIds: vpc.privateSubnets,
    nodeRoleArn: nodeRole.arn,
  });

  // 5. Dedicated Managed Node Group for TiKV Storage Nodes
  const tikvNodeGroup = new eks.ManagedNodeGroup("tikv-nodegroup", {
    cluster: cluster,
    nodeGroupName: "tikv-nodes",
    instanceTypes: ["m7g.large"],
    amiType: "AL2023_ARM_64_STANDARD",
    scalingConfig: {
      desiredSize: 3,
      minSize: 3,
      maxSize: 5,
    },
    labels: { dedicated: "tikv" },
    taints: [{ key: "dedicated", value: "tikv", effect: "NO_SCHEDULE" }],
    subnetIds: vpc.privateSubnets,
    nodeRoleArn: nodeRole.arn,
  });

  const provider = new kubernetes.Provider("eks-provider", {
    kubeconfig: cluster.kubeconfigJson,
  });

  // 6. Install PingCAP TiDB Operator CRDs & Helm Chart
  const tidbCrds = new kubernetes.yaml.ConfigFile(
    "tidb-crds",
    {
      file: "https://raw.githubusercontent.com/pingcap/tidb-operator/v1.6.1/manifests/crd.yaml",
    },
    { provider }
  );

  const tidbOperatorNamespace = new kubernetes.core.v1.Namespace(
    "tidb-operator-ns",
    { metadata: { name: "tidb-operator" } },
    { provider }
  );

  const tidbOperator = new kubernetes.helm.v3.Release(
    "tidb-operator",
    {
      chart: "tidb-operator",
      version: "v1.6.1",
      repositoryOpts: { repo: "https://charts.pingcap.org" },
      namespace: "tidb-operator",
      values: {
        controllerManager: { replicas: 1 },
      },
    },
    { provider, dependsOn: [tidbCrds, tidbOperatorNamespace] }
  );

  // 7. Deploy TiKV Cluster (PD + TiKV) in tidb-cluster namespace
  const tidbClusterNamespace = new kubernetes.core.v1.Namespace(
    "tidb-cluster-ns",
    { metadata: { name: "tidb-cluster" } },
    { provider }
  );

  const tidbCluster = new kubernetes.apiextensions.CustomResource(
    "tidb-cluster",
    {
      apiVersion: "pingcap.com/v1alpha1",
      kind: "TidbCluster",
      metadata: {
        name: "basic",
        namespace: "tidb-cluster",
      },
      spec: {
        version: "v8.5.0",
        timezone: "UTC",
        pvReclaimPolicy: "Retain",
        tlsCluster: { enabled: false },
        pd: {
          baseImage: "pingcap/pd",
          replicas: 3,
          requests: { storage: "10Gi" },
          storageClassName: "gp3",
          nodeSelector: { dedicated: "pd" },
          tolerations: [{ key: "dedicated", value: "pd", effect: "NoSchedule" }],
        },
        tikv: {
          baseImage: "pingcap/tikv",
          replicas: 3,
          requests: { storage: "50Gi" },
          storageClassName: "gp3",
          nodeSelector: { dedicated: "tikv" },
          tolerations: [{ key: "dedicated", value: "tikv", effect: "NoSchedule" }],
        },
      },
    },
    {
      provider,
      dependsOn: [
        tidbOperator,
        tidbClusterNamespace,
        pdNodeGroup,
        tikvNodeGroup,
        ebsCsiDriverAddon,
      ],
    }
  );

  // 8. Deploy SurrealDB Helm Release backed by TiKV PD endpoint
  const tikvPdEndpoint = "tikv://basic-pd.tidb-cluster.svc.cluster.local:2379";

  const surrealdb = new kubernetes.helm.v3.Release(
    "surrealdb",
    {
      chart: "surrealdb",
      repositoryOpts: { repo: "https://surrealdb.github.io/helm-charts" },
      version: "0.3.7",
      namespace: "default",
      values: {
        replicaCount: 2,
        image: {
          pullPolicy: "IfNotPresent",
          repository: "surrealdb/surrealdb",
          tag: "v2.2.2",
        },
        surrealdb: {
          auth: false,
          path: tikvPdEndpoint,
          log: "info",
        },
        service: {
          type: "LoadBalancer",
          port: 8000,
          annotations: {
            "service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
            "service.beta.kubernetes.io/aws-load-balancer-scheme": "internet-facing",
          },
        },
      },
    },
    { provider, dependsOn: [tidbCluster] }
  );

  const surrealService = kubernetes.core.v1.Service.get(
    "surrealdb-lb-svc",
    pulumi.interpolate`default/${surrealdb.name}`,
    { provider, dependsOn: [surrealdb] }
  );

  const surrealdbEndpoint = surrealService.status.apply((status) => {
    const host = status?.loadBalancer?.ingress?.[0]?.hostname || "localhost";
    return `http://${host}:8000`;
  });

  return {
    clusterName: cluster.eksCluster.name,
    kubeconfig: cluster.kubeconfig,
    surrealdbEndpoint,
    tikvPdEndpoint,
  };
};

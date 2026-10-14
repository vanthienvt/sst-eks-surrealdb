import { Stack, StackContext } from "sst/constructs";
import * as eks from "aws-cdk-lib/aws-eks";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";

export function EksStack({ stack }: StackContext) {
  const vpc = new ec2.Vpc(stack, "SurrealDBVPC", {
    maxAzs: 3,
    natGateways: 1,
  });

  const cluster = new eks.Cluster(stack, "SurrealDBCluster", {
    vpc,
    version: eks.KubernetesVersion.V1_30,
    defaultCapacity: 2,
    defaultCapacityInstance: ec2.InstanceType.of(
      ec2.InstanceClass.M5,
      ec2.InstanceSize.LARGE
    ),
  });

  // 1. Dedicated Node Group for PD
  const pdNg = cluster.addNodegroupCapacity("PDNodeGroup", {
    instanceTypes: [
      ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE),
    ],
    minSize: 3,
    maxSize: 3,
    desiredSize: 3,
    labels: { dedicated: "pd" },
    taints: [
      {
        key: "dedicated",
        value: "pd",
        effect: eks.TaintEffect.NO_SCHEDULE,
      },
    ],
  });
  pdNg.role.addManagedPolicy(
    iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEBSCSIDriverPolicy")
  );

  // 2. Dedicated Node Group for TiKV
  const tikvNg = cluster.addNodegroupCapacity("TiKVNodeGroup", {
    instanceTypes: [
      ec2.InstanceType.of(ec2.InstanceClass.R5B, ec2.InstanceSize.XLARGE2),
    ],
    minSize: 3,
    maxSize: 5,
    desiredSize: 3,
    labels: { dedicated: "tikv" },
    taints: [
      {
        key: "dedicated",
        value: "tikv",
        effect: eks.TaintEffect.NO_SCHEDULE,
      },
    ],
  });
  tikvNg.role.addManagedPolicy(
    iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEBSCSIDriverPolicy")
  );

  // 3. Install TiDB Operator Helm Chart
  const tidbOperator = cluster.addHelmChart("TiDBOperator", {
    chart: "tidb-operator",
    repository: "https://charts.pingcap.org",
    namespace: "tidb-operator",
    createNamespace: true,
    version: "v1.6.1",
  });

  // 4. Deploy TiKV Cluster (PD + TiKV) Custom Resource
  const tidbCluster = cluster.addManifest("TiKVCluster", {
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
      pd: {
        baseImage: "pingcap/pd",
        replicas: 3,
        requests: { storage: "10Gi" },
        nodeSelector: { dedicated: "pd" },
        tolerations: [{ key: "dedicated", value: "pd", effect: "NoSchedule" }],
      },
      tikv: {
        baseImage: "pingcap/tikv",
        replicas: 3,
        requests: { storage: "50Gi" },
        nodeSelector: { dedicated: "tikv" },
        tolerations: [{ key: "dedicated", value: "tikv", effect: "NoSchedule" }],
      },
    },
  });
  tidbCluster.node.addDependency(tidbOperator);

  // 5. Deploy SurrealDB Helm Chart backed by TiKV
  const surrealRelease = cluster.addHelmChart("SurrealDB", {
    chart: "surrealdb",
    repository: "https://surrealdb.github.io/helm-charts",
    namespace: "default",
    version: "0.3.7",
    values: {
      surrealdb: {
        auth: false,
        path: "tikv://basic-pd.tidb-cluster.svc.cluster.local:2379",
      },
      service: {
        type: "LoadBalancer",
        port: 8000,
      },
    },
  });
  surrealRelease.node.addDependency(tidbCluster);

  stack.addOutputs({
    ClusterName: cluster.clusterName,
    TiKVEndpoint: "tikv://basic-pd.tidb-cluster.svc.cluster.local:2379",
  });
}
/// <reference path="./.sst/platform/config.d.ts" />

import { setupSurrealdb } from "./surrealdb";

export default $config({
  app(input) {
    return {
      name: "sst-eks-surrealdb",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: {
          region: "us-east-1",
        },
        eks: "2.7.0",
        kubernetes: "4.18.0",
      },
    };
  },
  async run() {
    const vpc = new sst.aws.Vpc("SurrealDBVpc", {
      nat: "managed",
    });

    const surrealCluster = await setupSurrealdb(vpc);

    const honoApi = new sst.aws.Function("HonoService", {
      handler: "examples/hono-service/index.handler",
      url: true,
      vpc,
      environment: {
        SURREALDB_URL: surrealCluster.surrealdbEndpoint,
        SURREALDB_USER: process.env.SURREALDB_USER || "root",
        SURREALDB_PASS: process.env.SURREALDB_PASS || "root",
        SURREALDB_NS: process.env.SURREALDB_NS || "production",
        SURREALDB_DB: process.env.SURREALDB_DB || "main",
      },
    });

    return {
      ClusterName: surrealCluster.clusterName,
      TiKVEndpoint: surrealCluster.tikvPdEndpoint,
      SurrealDBEndpoint: surrealCluster.surrealdbEndpoint,
      HonoServiceUrl: honoApi.url,
    };
  },
});

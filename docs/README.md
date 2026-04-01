# MultiSubs Documentation

MultiSubs is a multi-tenant Banking-as-a-Service platform on Base. Companies integrate it to offer USDC custody, card issuance, real-time authorization, on-chain settlement, and yield — through a REST API.

## Documents

| Document                                    | Audience                                             | What it covers                                                                                              |
| ------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Infrastructure](./infrastructure.md)       | Engineers working on or evaluating the platform      | System architecture, smart contracts, backend services, data stores, core flows, security model, deployment |
| [Integration Guide](./integration-guide.md) | Engineering teams at companies integrating MultiSubs | Step-by-step integration, API reference, SDK usage, webhook handling, code examples, production checklist   |

## Reading Order

**If you're integrating MultiSubs into your product**, start with the [Integration Guide](./integration-guide.md). It has everything you need: credentials setup, SDK initialization, user/card/KYC flows, webhook verification, and a full API reference.

**If you're working on or evaluating the platform internals**, start with [Infrastructure](./infrastructure.md). It covers how authorization, settlement, sweeps, and yield work under the hood, plus the smart contract architecture and deployment model.

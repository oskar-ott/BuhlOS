// Type declarations for the CommonJS runtime wiring the Next inbound route
// imports (api/_lib/invoices/runtime.js).

import type { InboundWebhookDeps } from "./webhook";

export declare function webhookDeps(): InboundWebhookDeps;

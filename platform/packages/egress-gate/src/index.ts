/**
 * @zr-legal/egress-gate —— 出站闸门（v9 第 04 篇 §5.1）：律师电脑上的独立进程、唯一出口。
 */
export * from "./types.ts";
export * from "./server.ts";
export { checkUrlStatic, isPublicAddress, DEFAULT_ALLOWED_PORTS } from "./url-guard.ts";
export { gateFetch, FetchDenied, htmlToText } from "./fetcher.ts";
export { screenSearchQuery, type DataLevel, type SearchVerdict } from "./search-guard.ts";
export { processChatPayload } from "./chat-payload.ts";
export { extractUsage } from "./usage.ts";
export { OFFICIAL_SITE_BASELINE } from "./baseline.ts";
export { checkUpstream, isLoopbackHost, normalizePins, PIN_RE, spkiPin, type TransportCheck, type TransportState } from "./tls-check.ts";
export { cpRelayAllowed, relayControlPlane, CP_MAX_REQUEST_BYTES, CP_MAX_RESPONSE_BYTES, type CpRelayRequest, type CpRelayResult } from "./cp-relay.ts";
export { distRelayAllowed, relayDist, DIST_MAX_RESPONSE_BYTES, type DistRelayResult } from "./dist-relay.ts";
export { canonicalCredential, egressDigest, verifyApproval, type ApprovalCredential, type ApprovalExpectation, type ApprovalPurpose, type SignedApproval } from "./approval.ts";

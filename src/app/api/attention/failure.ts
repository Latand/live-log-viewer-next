import { NextResponse } from "next/server";

import { AttentionStoreError, AttentionValidationError } from "@/lib/attention/store";
import { AttentionRequestError } from "@/lib/attention/validation";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

/**
 * One error-to-response mapping for both attention routes (#688).
 *
 * The distinction that matters here is who is at fault. A malformed body is the
 * caller's problem and a 400 tells them to stop. Contention on the attention
 * file is the server's, and a correct client should come back — which is why
 * `FileTransactionBusyError` is a 503 rather than being swept into the trailing
 * "invalid request": telling a well-formed caller their request was invalid
 * because a lock was held is both wrong and unretryable.
 */

const headers = { "Cache-Control": "no-store" };

export function attentionFailure(error: unknown): NextResponse {
  if (error instanceof AttentionRequestError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status, headers });
  }
  if (error instanceof AttentionValidationError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 400, headers });
  }
  if (error instanceof FileTransactionBusyError) {
    return NextResponse.json(
      { error: "ATTENTION_STATE_BUSY", message: error.message },
      { status: 503, headers: { ...headers, "Retry-After": "1" } },
    );
  }
  if (error instanceof AttentionStoreError) {
    return NextResponse.json({ error: "ATTENTION_STATE_UNAVAILABLE", message: error.message }, { status: 503, headers });
  }
  return NextResponse.json({ error: "INVALID_REQUEST", message: "invalid request" }, { status: 400, headers });
}

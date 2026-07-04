/** Failure stage for falsifiable tests and CLI exit messaging (ADR-0045). */
export type ReceiptVerifyStage = "parse" | "signature" | "inclusion" | "binding";

export type ReceiptVerifyResult = {
  ok: boolean;
  stage: ReceiptVerifyStage;
  /** Present when ok === false; stable snake_case token for tests. */
  reason?: string;
};

/** Only a rejected reference is safe to replay automatically. Never retry generation failures. */
export function isInteractionAccessError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: { message?: unknown; status?: unknown } }).error;
  return error?.status === "UNAUTHENTICATED" || error?.status === "PERMISSION_DENIED"
    || (typeof error?.message === "string" && /api[\s_-]*key|credential|authentication|unauthenticated|permission|access denied/i.test(error.message));
}

export function isInvalidInteractionReference(status: number, value: unknown): boolean {
  if (![400, 404, 410].includes(status) || !value || typeof value !== "object") return false;
  if (isInteractionAccessError(value)) return false;
  const error = (value as { error?: { message?: unknown; param?: unknown } }).error;
  if (error?.param === "previous_interaction_id") return true;
  const message = typeof error?.message === "string" ? error.message : "";
  const reference = /previous[_\s-]*interaction|interaction[_\s-]*(id|reference)|(?:stored|prior|parent)\s+interaction/i;
  const rejected = /invalid|expired|not found|not exist|no longer|deleted|cannot (?:find|load|retrieve)|could not (?:find|load|retrieve)/i;
  return reference.test(message) && rejected.test(message);
}

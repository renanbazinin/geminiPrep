import { expect, it } from "vitest";
import { isInvalidInteractionReference } from "./interaction-errors.js";

it.each([
  [400, "Invalid previous_interaction_id"], [404, "Previous interaction not found"],
  [410, "Stored interaction has expired"], [400, "Interaction ID is invalid"],
])("recognizes a rejected reference: %s %s", (status, message) => {
  expect(isInvalidInteractionReference(status, { error: { message } })).toBe(true);
});
it.each([
  [404, "Model not found"], [404, "Not found"], [400, "Invalid JSON schema"],
  [401, "Previous interaction not found"], [403, "Previous interaction not found"],
  [429, "Invalid previous_interaction_id"], [500, "Could not load previous interaction"],
])("leaves unrelated or uncertain errors alone: %s %s", (status, message) => {
  expect(isInvalidInteractionReference(status, { error: { message } })).toBe(false);
});

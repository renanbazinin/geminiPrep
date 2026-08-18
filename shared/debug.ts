export type DebugCompactOptions = {
  maxStringCharacters: number;
  maxArrayItems: number;
};

export function compactDebugValue(value: unknown, options: DebugCompactOptions): unknown {
  if (typeof value === "string" && value.length > options.maxStringCharacters) {
    const labelRoom = 100;
    const side = Math.max(1, Math.floor((options.maxStringCharacters - labelRoom) / 2));
    return `${value.slice(0, side)}\n… ${value.length - side * 2} characters omitted from the middle …\n${value.slice(-side)}`;
  }
  if (Array.isArray(value)) {
    if (value.length > options.maxArrayItems) {
      const headCount = Math.ceil((options.maxArrayItems - 1) / 2);
      const tailCount = Math.floor((options.maxArrayItems - 1) / 2);
      return [
        ...value.slice(0, headCount).map((entry) => compactDebugValue(entry, options)),
        `… ${value.length - headCount - tailCount} items omitted from the middle …`,
        ...value.slice(-tailCount).map((entry) => compactDebugValue(entry, options)),
      ];
    }
    return value.map((entry) => compactDebugValue(entry, options));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const imageData = record.data;
    if (
      typeof record.mimeType === "string"
      && record.mimeType.startsWith("image/")
      && typeof imageData === "string"
      && imageData.length > 80
    ) {
      return Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [
          key,
          key === "data" ? `[${imageData.length} base64 characters omitted]` : compactDebugValue(entry, options),
        ]),
      );
    }
    return Object.fromEntries(
      Object.entries(record)
        .map(([key, entry]) => [key, compactDebugValue(entry, options)]),
    );
  }
  return value;
}

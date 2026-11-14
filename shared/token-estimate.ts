// The app's own token estimate, for the browser and the server. It is the estimator of
// llm-large-files 0.5.0 (src/text.ts), copied here because the package's entry point imports Node
// modules and cannot be loaded in the browser. The browser needs the same number the server will
// work with: a file it keeps is one the server would have sent in full too.
// shared/token-estimate.test.ts fails when the two stop agreeing, for example after a new version
// of the package changes its estimator. Copy the new one here then.

// Token cost of each kind of character, fitted to Gemini's countTokens on 60 texts (prose in
// eleven languages, source code, JSON, CSV, and eight log formats; Gemini 2.5, 3.5, and 3.8 count
// identically). On those texts the estimate is between 0.98 and 1.7 times Gemini's count.
const WORD = 1.1; // A run of ASCII letters.
const CASE_CHANGE = 1.3; // "camelCase", "HTTPServer", base64: each change starts a new piece.
const LONG_LETTER = 0.18; // Each letter past the 6th of a piece (the 3rd for capitals).
const LONG_AFTER = 6;
const LONG_AFTER_CAPITALS = 3;
const VERY_LONG_LETTER = 0.5; // Each letter past the 20th: no longer a word, but a key or a sequence.
const VERY_LONG_AFTER = 20;
const DIGIT = 1.2; // Digits are about one token each, so IDs, timestamps, and numbers are dense.
const PUNCTUATION = 0.85; // The first of a run of ASCII punctuation; the rest of the run is free.
const NEWLINE = 2.2;
const TAB = 1;
const LOOSE_SPACE = 0.2; // A space before anything but a letter. A space before a word is free.
const LATIN_EXTENDED = 0.6; // é, ü, ß
const GREEK = 0.4;
const CYRILLIC = 0.3;
const HEBREW = 0.52;
const ARABIC = 0.41;
const OTHER_SCRIPT = 0.45; // Devanagari, Thai, Georgian, and other alphabets and syllabaries.
const HAN = 0.7;
const KANA = 0.56;
const HANGUL = 0.7;
const SURROGATE = 0.5; // Half of an emoji or another character outside the basic plane.
const SYMBOL = 1; // Dashes, quotes, arrows, box drawing, and anything unclassified.

/**
 * Estimates how many tokens a model will count for `text`, without calling the model.
 *
 * Characters per token varies a lot with the kind of text: about 4.5 for English prose, 2 for
 * Hebrew, and between 1 and 2 for logs, CSV, and hex, because digits cost about a token each. A
 * flat "4 characters per token" is therefore right for a novel and three times too low for a log.
 * This walks the text once and prices each kind of character. It leans high, which only moves a
 * file to the server sooner. The one kind of text it still counts low is a long run of random
 * letters in a single case with no digits (about 70% of the real count).
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  // The current run of ASCII letters: its length since the last case change, and its casing.
  let piece = 0;
  let capitalsInARow = 0;
  let previousWasLower = false;
  let previous = 0; // 1 = space, 2 = ASCII punctuation, 0 = anything else
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90)) {
      const capital = code <= 90;
      if (piece === 0) tokens += WORD;
      else if ((capital && previousWasLower) || (!capital && capitalsInARow >= 2)) {
        tokens += CASE_CHANGE;
        piece = 0;
      }
      piece++;
      if (piece > VERY_LONG_AFTER) tokens += VERY_LONG_LETTER;
      else if (piece > (capital ? LONG_AFTER_CAPITALS : LONG_AFTER)) tokens += LONG_LETTER;
      capitalsInARow = capital ? capitalsInARow + 1 : 0;
      previousWasLower = !capital;
      previous = 0;
      continue;
    }
    piece = 0;
    capitalsInARow = 0;
    previousWasLower = false;
    if (code === 32) {
      previous = 1;
      continue;
    }
    if (previous === 1) tokens += LOOSE_SPACE;
    if (code < 0x80) {
      if (code >= 48 && code <= 57) tokens += DIGIT;
      else if (code === 10) tokens += NEWLINE;
      else if (code === 9) tokens += TAB;
      else {
        if (previous !== 2) tokens += PUNCTUATION;
        previous = 2;
        continue;
      }
      previous = 0;
      continue;
    }
    previous = 0;
    if (code < 0xc0) tokens += SYMBOL;
    else if (code < 0x250) tokens += LATIN_EXTENDED;
    else if (code < 0x370) tokens += OTHER_SCRIPT;
    else if (code < 0x400) tokens += GREEK;
    else if (code < 0x530) tokens += CYRILLIC;
    else if (code < 0x590) tokens += OTHER_SCRIPT;
    else if (code < 0x600) tokens += HEBREW;
    else if (code < 0x700) tokens += ARABIC;
    else if (code < 0x2000) tokens += OTHER_SCRIPT;
    else if (code < 0x2e80) tokens += SYMBOL;
    else if (code < 0x3400) tokens += KANA;
    else if (code < 0xac00) tokens += HAN;
    else if (code < 0xd800) tokens += HANGUL;
    else if (code < 0xe000) tokens += SURROGATE;
    else if (code < 0xf900) tokens += SYMBOL;
    else if (code < 0xfb00) tokens += HAN;
    else if (code < 0xff00) tokens += OTHER_SCRIPT;
    else tokens += KANA;
  }
  return Math.ceil(tokens);
}

/** Structured, fail-closed transport for web PDF generation. */

export const OPEN_MARK = "<<voyager-draft>>";
export const CLOSE_MARK = "<</voyager-draft>>";

export const VOYAGER_DRAFT_INSTRUCTION =
  `Do NOT save or edit files. Output one complete JSON document draft between a line containing only \`${OPEN_MARK}\` and a line containing only \`${CLOSE_MARK}\`. Include candidate, variant, headline, evidence, cv, and cover. Do not include paths, report, HTML, or TeX; the platform assigns those immutable values and renders both documents.`;

/** @typedef {{ok: true, draft: object, warnings: string[]} | {ok: false, error: string}} VoyagerDraftEnvelope */

export function parseVoyagerDraftEnvelope(text) {
  if (typeof text !== "string") return { ok: false, error: "No agent output to read a Voyager draft from." };
  const normalized = text.replace(/\r\n/g, "\n");
  const openers = [...normalized.matchAll(/^<<voyager-draft>>[ \t]*$/gm)];
  if (openers.length !== 1) return { ok: false, error: `Expected exactly one ${OPEN_MARK} envelope, found ${openers.length}.` };
  const after = normalized.slice(openers[0].index + openers[0][0].length);
  const closer = after.match(/^<<\/voyager-draft>>[ \t]*$/m);
  if (!closer) return { ok: false, error: "The Voyager draft envelope was never closed." };
  const body = after.slice(0, closer.index).replace(/^\n/, "").replace(/\n$/, "").trim();
  if (!body) return { ok: false, error: "The Voyager draft envelope was empty." };
  try {
    const draft = JSON.parse(body);
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("must be a JSON object");
    return { ok: true, draft, warnings: [] };
  } catch (error) {
    return { ok: false, error: `The Voyager draft is not valid JSON: ${error.message}` };
  }
}

/** Buffer envelope content so raw draft JSON never floods the run log. */
export function createVoyagerDraftFilter() {
  let raw = "";
  let visible = "";
  let inDraft = false;
  return {
    push(chunk) {
      raw += String(chunk ?? "");
      const lines = String(chunk ?? "").split(/(?<=\n)/);
      let out = "";
      for (const line of lines) {
        if (line.trim() === OPEN_MARK) { inDraft = true; continue; }
        if (line.trim() === CLOSE_MARK) { inDraft = false; continue; }
        if (!inDraft) out += line;
      }
      visible += out;
      return out;
    },
    flush() { return ""; },
    result() { return parseVoyagerDraftEnvelope(raw); },
  };
}

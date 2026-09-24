const PIPELINE_ROOT = "/pipeline";

/** Build a report URL that remembers the current pipeline view. */
export function pipelineDetailHref(id, query = "") {
  const returnTo = `${PIPELINE_ROOT}${query ? `?${query}` : ""}`;
  return `${PIPELINE_ROOT}/${encodeURIComponent(id)}?from=${encodeURIComponent(returnTo)}`;
}

/** Keep report return links inside the pipeline; never honor an external target. */
export function pipelineReturnHref(from) {
  if (typeof from !== "string") return PIPELINE_ROOT;
  if (from === PIPELINE_ROOT || from.startsWith(`${PIPELINE_ROOT}?`)) return from;
  return PIPELINE_ROOT;
}

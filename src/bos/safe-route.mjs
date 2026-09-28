export function validateSafeBosRoute(value, label = "BOS route", {organizationTemplate = false} = {}) {
  const invalid = () => { throw new TypeError(`${label} must be a safe origin-relative /bos/ URI`); };
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
      !value.startsWith("/bos/") || value.startsWith("//") ||
      /[\u0000-\u0020\u007f\\#]/u.test(value) ||
      /%(?![0-9a-f]{2})/iu.test(value)) invalid();
  let decoded;
  let decodedPath;
  const rawPath = value.split("?", 1)[0];
  if (/%2f/iu.test(rawPath)) invalid();
  try {
    decoded = decodeURIComponent(value);
    decodedPath = decodeURIComponent(rawPath);
  } catch { invalid(); }
  if (!decoded.startsWith("/bos/") || /[\u0000-\u0020\u007f\\#]/u.test(decoded) || decodedPath.includes("?") ||
      decodedPath.includes("//") || decodedPath.split("/").some((segment) => segment === "." || segment === "..")) invalid();
  if (organizationTemplate && !rawPath.includes("/{organization}/")) {
    throw new TypeError(`${label} must be a public organization route template`);
  }
  return value;
}

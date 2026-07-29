export function trustedPipedriveBaseUrl(input: string): string {
  const url = new URL(input);
  const hostname = url.hostname.toLowerCase();
  const trustedHost =
    hostname === "api.pipedrive.com" || hostname.endsWith(".pipedrive.com");
  if (
    url.protocol !== "https:" ||
    !trustedHost ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Pipedrive API base URL must be a credential-free HTTPS origin on pipedrive.com",
    );
  }
  return url.origin;
}

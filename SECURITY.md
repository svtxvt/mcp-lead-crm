# Security

`mcp-lead-crm` is a local stdio server. It does not open a listening port and ships no credentials.

- Keep secrets out of the repository and JSON/CSV lead data.
- Configure the optional n8n webhook only through `N8N_WEBHOOK_URL`.
- Without that variable, webhook calls are dry runs and make no network request. A dry-run activity is recorded only when `lead_id` is supplied.
- Treat `LEAD_CRM_DB`, imported CSV paths, and exported lead files as sensitive business data. CSV validation resolves canonical parent directories, enforces containment within the database directory, and compares device/inode identity to reject database aliases. Export destinations cannot be symlinks; exports are published by temporary file plus atomic rename.
- Keep the database directory under trusted local ownership. These checks and cooperative process locks are not a sandbox against another local process maliciously replacing directories during filesystem operations.
- The example workflow ends in a disabled no-op email placeholder. It has only been structurally validated; live n8n import/execution and downstream actions have not been verified.
- Use an HTTPS webhook you control. Only HTTP(S) URLs without embedded username/password are accepted, and redirects are refused. The configured destination is trusted configuration: local/private-network addresses are not blocked, and the receiver controls any downstream forwarding.
- Webhook fetches combine a ten-second deadline (including response-body consumption) with the MCP request cancellation signal. Successful results expose the HTTP status, not the receiver's response body. Application errors return generic client messages; detailed diagnostics go to stderr, so protect those logs as sensitive.
- Graceful shutdown waits up to five seconds for started operations. Cancellation, timeout, forced termination, or persistence failure can leave a remotely accepted webhook without a local activity record; reconcile with the receiver before retrying.
- Report vulnerabilities privately to the repository owner; do not include real lead data or secrets.

The fictional seed records use `@example.com` addresses and are not customer data.

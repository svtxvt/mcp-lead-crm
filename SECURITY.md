# Security

`mcp-lead-crm` is a local stdio server. It does not open a listening port and contains no credentials.

- Keep secrets out of the repository and JSON/CSV lead data.
- Configure the optional n8n webhook only through `N8N_WEBHOOK_URL`.
- Without that variable, webhook calls are dry runs and make no network request.
- Treat `LEAD_CRM_DB`, imported CSV paths, and exported lead files as sensitive business data. CSV paths are confined to the database directory.
- The example workflow ends in a disabled no-op email placeholder and sends no data to a third party.
- Use an HTTPS webhook you control. The process sends the event payload only to that configured URL.
- Report vulnerabilities privately to the repository owner; do not include real lead data or secrets.

The fictional seed records use `@example.com` addresses and are not customer data.

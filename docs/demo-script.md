# 60-second demo script

Start with `npm run seed` and leave `N8N_WEBHOOK_URL` unset.

1. “Add Priya Shah from Cedar Lane Florist, priya.shah@example.com, source referral. She wants follow-up automation.”
2. “Qualify the lead you just added with score 84. Reason: clear need, budget, and a two-week timeline.”
3. “Log a task for that lead: send the workflow outline tomorrow at 10:00 UTC.”
4. “Show me all follow-ups due in the next three days, including overdue ones.”
5. “Trigger the follow-up email n8n event for Priya with payload `{"tone":"friendly"}`. Keep it as a dry run.”
6. “Show the first 20 leads in the pipeline.”

The GIF/MP4 is an edited illustration and omits arguments. For step 2, the complete tool arguments are (replace the ID with the lead returned by step 1):

```json
{"id":"L-0021","score":84,"reason":"Clear need, budget, and a two-week timeline"}
```

Step 5 previews a POST without sending it. A dry-run activity is saved only when the tool call includes that lead's `lead_id`.

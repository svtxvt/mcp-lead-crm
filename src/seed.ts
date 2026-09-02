import { resolve } from "node:path";
import { JsonStore, type Activity, type Lead, type Stage } from "./store.js";

const now = Date.now();
const day = 86_400_000;
const iso = (offset: number) => new Date(now + offset * day).toISOString();
const companies = [
  ["Avery Brooks", "Brewline Coffee", "avery.brooks@example.com", "website"],
  ["Mina Patel", "Northwind Dental", "mina.patel@example.com", "referral"],
  ["Leo Martin", "Harbor & Pine", "leo.martin@example.com", "instagram"],
  ["Nora Chen", "Brightpath Tutors", "nora.chen@example.com", "linkedin"],
  ["Elias Moore", "Juniper Fitness", "elias.moore@example.com", "ads"],
  ["Sofia Reyes", "Mosaic Pet Care", "sofia.reyes@example.com", "website"],
  ["Theo Grant", "Copperline Studio", "theo.grant@example.com", "referral"],
  ["Amara Lewis", "Kindred Kitchens", "amara.lewis@example.com", "other"],
  ["Jonas Klein", "Bluebird Plumbing", "jonas.klein@example.com", "ads"],
  ["Iris Park", "Summit Cycle Works", "iris.park@example.com", "linkedin"],
  ["Owen Bell", "Willow Accounting", "owen.bell@example.com", "website"],
  ["Zara Ali", "Fieldstone Bakery", "zara.ali@example.com", "instagram"],
] as const;
const stages: Stage[] = ["new", "qualified", "contacted", "proposal", "won", "lost", "unqualified", "contacted", "proposal", "new", "qualified", "won"];

const leads: Lead[] = companies.map(([name, company, email, source], index) => {
  const created = iso(-14 + index);
  const activities: Activity[] = index < 3
    ? [{ id: `A-${String(index + 1).padStart(4, "0")}`, type: "task", note: "Send the promised follow-up", created_at: created, due_at: iso(-3 + index) }]
    : [];
  return {
    id: `L-${String(index + 1).padStart(4, "0")}`,
    name,
    company,
    email,
    source,
    stage: stages[index]!,
    ...(stages[index] !== "new" ? { score: 55 + ((index * 7) % 40) } : {}),
    created_at: created,
    updated_at: activities.at(-1)?.created_at ?? created,
    notes: "Fictional demo lead",
    activities,
  };
});

const path = process.env.LEAD_CRM_DB ?? "./data/crm.json";
const store = new JsonStore(path);
if (process.env.LEAD_CRM_SEED_FORCE !== "1" && (await store.listLeads(undefined, 1)).length > 0) {
  throw new Error("Refusing to replace a non-empty CRM. Set LEAD_CRM_SEED_FORCE=1 to reset it with fictional demo data.");
}
await store.replace(leads);
console.log(`Seeded 12 fictional leads at ${resolve(path)} (3 overdue follow-ups).`);

import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { json } from "@/lib/server/http";

/**
 * The engine's GET /api/industries lists the industry reference files under
 * .claude/skills/geo-content-writer/references/industries/. The hosted build has no repo to
 * glob, so this is that directory's contents, sorted exactly as list_industries sorts them.
 * When a reference file is added there, add its stem here.
 */
const INDUSTRIES = [
  "accounting-tax",
  "beauty-fashion",
  "education",
  "finance",
  "healthcare",
  "hospitality",
  "hr-recruitment",
  "legal",
  "management-consulting",
  "media-publishing",
  "real-estate",
  "technology-saas",
];

export async function GET(request: Request) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  return json({ industries: INDUSTRIES });
}

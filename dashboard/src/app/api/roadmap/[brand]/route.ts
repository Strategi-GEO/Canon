import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { buildRoadmap } from "@/lib/server/portal-data";

/**
 * The brand's content roadmap, read-only. The portal has no roadmap mutation of any kind:
 * no upload, no generate, no delete. Out-of-scope and nonexistent answer the same 404.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ brand: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand } = await params;
  // ?month=N narrows to one month's sheet; absent means every row across months. Same
  // validation as the admin sheet route: malformed is a 400.
  const monthRaw = new URL(request.url).searchParams.get("month");
  if (monthRaw !== null && !/^[1-9]\d*$/.test(monthRaw)) {
    return detail(400, `month must be a positive integer, got '${monthRaw}'`);
  }
  try {
    const roadmap = await buildRoadmap(
      user.token,
      brand,
      monthRaw === null ? undefined : Number(monthRaw),
    );
    if (roadmap === null) {
      return detail(404, `unknown brand '${brand}'`);
    }
    return json(roadmap);
  } catch (cause) {
    return failure(cause);
  }
}

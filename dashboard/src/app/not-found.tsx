import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The catch all for a path that matches no route. A missing org or brand does NOT land here:
 * those resolve against the engine's list, so they get a state that names the org or brand
 * that was not found instead of this generic one.
 */
export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardContent className="py-12 text-center">
          <SearchX className="mx-auto size-5 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm font-medium text-foreground">This page does not exist</p>
          <p className="mx-auto mt-2 max-w-sm text-xs text-muted-foreground">
            Blogs live under a brand, and a brand lives under an organisation. Pick one to
            get back to work.
          </p>
          <Button variant="outline" size="sm" className="mt-5" asChild>
            <Link href="/">Go to your clients</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

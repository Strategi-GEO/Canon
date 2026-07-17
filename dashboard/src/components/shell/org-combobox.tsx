"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { useOrgs } from "@/lib/orgs-context";
import { cn } from "@/lib/utils";

/**
 * Pick an existing organisation or type a new one.
 *
 * A native datalist rather than a custom popover: the two behaviours this field needs are
 * "suggest what exists" and "accept anything typed", which is exactly what datalist does,
 * and it stays keyboard and screen reader correct without a listbox to maintain.
 *
 * The value is the org NAME, not a slug. The engine slugifies and matches, so an operator
 * typing an existing name lands in that org rather than creating a near duplicate.
 */
export function OrgCombobox({
  id,
  value,
  onChange,
  className,
  required = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  required?: boolean;
}) {
  const { orgs } = useOrgs();
  const listId = `${id}-orgs`;

  const match = orgs.find((org) => org.name.toLowerCase() === value.trim().toLowerCase());

  return (
    <div className={className}>
      <Input
        id={id}
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Vacation Village"
        autoComplete="off"
        required={required}
      />
      <datalist id={listId}>
        {orgs.map((org) => (
          <option key={org.slug} value={org.name} />
        ))}
      </datalist>

      {/* Which of the two things is about to happen, said before it happens. Filing a brand
          under the wrong org is cheap to fix, but only if the operator notices it. */}
      {value.trim() === "" ? null : (
        <p
          className={cn(
            "mt-1 text-xs",
            match ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {match ? (
            <>
              Joins <span className="font-medium">{match.name}</span>, which has{" "}
              <span className="machine">{match.brands.length}</span>{" "}
              {match.brands.length === 1 ? "brand" : "brands"}.
            </>
          ) : (
            <>
              Creates a new organisation named{" "}
              <span className="font-medium">{value.trim()}</span>.
            </>
          )}
        </p>
      )}
    </div>
  );
}

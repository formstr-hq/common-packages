import { useEffect, useState } from "react";

export type Route = { name: "boards" } | { name: "board"; coordinate: string };

function parse(hash: string): Route {
  const match = /^#\/board\/(.+)$/.exec(hash);
  if (match) return { name: "board", coordinate: decodeURIComponent(match[1]) };
  return { name: "boards" };
}

/** A coordinate contains `:`, so it is encoded into the hash rather than pathed. */
export function boardHref(coordinate: string): string {
  return `#/board/${encodeURIComponent(coordinate)}`;
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

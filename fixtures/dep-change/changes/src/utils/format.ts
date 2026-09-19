import { kebabCase } from "lodash";

export function slugify(input: string): string {
  return kebabCase(input);
}

export function titleOf(name: string): string {
  return name.replace(/_/g, " ");
}

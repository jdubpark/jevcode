import { z } from "zod";

import { fetchJson } from "./helpers/http";
import { slugify, titleOf } from "./utils/format";

interface Post {
  id: number;
  title: string;
}

const postSchema = z.object({ id: z.number(), title: z.string() });

export async function run(): Promise<string> {
  const post = await fetchJson("https://example.com/posts/1", postSchema);
  return slugify(post.title);
}

export function describe(post: Post): string {
  return titleOf(post.title);
}

import { fetchJson } from "./helpers/http";
import { slugify, titleOf } from "./utils/format";

interface Post {
  id: number;
  title: string;
}

export async function run(): Promise<string> {
  const post = await fetchJson<Post>("https://example.com/posts/1");
  return slugify(post.title);
}

export function describe(post: Post): string {
  return titleOf(post.title);
}

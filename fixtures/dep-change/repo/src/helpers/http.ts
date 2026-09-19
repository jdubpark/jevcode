import axios from "axios";

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await axios.get<T>(url);
  return response.data;
}

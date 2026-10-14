import { last } from "../lib/source-tm.ts";
export async function main(source_path: string): Promise<any> {
    return await last(source_path);
}
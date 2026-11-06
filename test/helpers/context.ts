// A small vault's link index for translator tests.
import { buildLinkIndex } from "../../src/links/index.ts";
import type { TranslateContext } from "../../src/translate/context.ts";

export const Elm = "cb56bbf0-dc78-4886-8553-6285651b9f5d";
export const SOUP = "595b6194-8d72-4785-8ce8-a4eb90e3e551";
export const DRAFT_A = "1273de38-b3ab-4c53-8cc5-3c4a76c06f7a";
export const DRAFT_B = "e8ed47c3-53ba-4130-8efd-802761b1339b";
export const OUTSIDE = "f81667b8-032f-4c48-8b1e-c45e19085615";

export const elmUrl = "https://app.notion.com/p/cb56bbf0dc78488685536285651b9f5d";
export const soupUrl = "https://app.notion.com/p/595b61948d7247858ce8a4eb90e3e551";

export function testContext(fromPath = "Notes/Current.md"): TranslateContext {
  const index = buildLinkIndex([
    { path: "Grove/Elm.md", pageId: Elm, title: "Elm" },
    { path: "Soup- Tomato.md", pageId: SOUP, title: "Soup: Tomato" },
    { path: "0-In/Draft.md", pageId: DRAFT_A, title: "Draft" },
    { path: "Archive/Draft (2).md", pageId: DRAFT_B, title: "Draft" },
    { path: "Layouts/Floor Plan.md", pageId: null, title: "Floor Plan" },
    { path: fromPath, pageId: "11111111-1111-1111-1111-111111111111", title: "Current" },
  ]);
  return { index, fromPath, vaultName: "DemoVault" };
}

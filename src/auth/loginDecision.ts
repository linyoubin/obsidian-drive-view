/** 0.2.14/0.2.15：登录成功后的去向（有快照且库根一致 → 直接挂载，零网络）。 */

export type QuarkLoginAction = "mount" | "confirm" | "choose-root" | "rebuild";

export function decideAfterLogin(input: {
  indexCount: number;
  rootChosen: boolean;
  rootMatches: boolean;
  secretAvailable?: boolean;
}): QuarkLoginAction {
  if (input.indexCount > 0 && input.rootChosen && input.rootMatches) return "mount";
  if (input.indexCount > 0 && !input.rootMatches) return "rebuild";
  if (!input.rootChosen) return "choose-root";
  return "confirm";
}

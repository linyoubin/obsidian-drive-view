/** 0.2.17：401 熔断提示闸（同一失效期只弹一次；登录成功后 reset）。 */
export class AuthNoticeGate {
  private shown = false;

  shouldShow(): boolean {
    if (this.shown) return false;
    this.shown = true;
    return true;
  }

  reset(): void {
    this.shown = false;
  }

  get visible(): boolean {
    return this.shown;
  }
}

export const QUARK_AUTH_FAILED_TEXT = "夸克登录已失效，云端内容无法读取 —— 「重新扫码」";
export const QUARK_AUTH_READ_BLOCKED_TEXT = "当前无法读取云端内容：登录已失效，请点「同步夸克」重新扫码";

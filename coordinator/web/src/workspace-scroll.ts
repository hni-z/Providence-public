/** Small viewport policy; it does not fetch, paginate, or change task history. */
export class WorkspaceScrollLanding {
  private context = "";
  private visible = false;
  private landed = false;

  update(context: string, visible: boolean, hasContent: boolean): boolean {
    if (context !== this.context || (visible && !this.visible)) this.landed = false;
    this.context = context;
    this.visible = visible;
    if (!visible || !hasContent || this.landed) return false;
    this.landed = true;
    return true;
  }
}

export function workspaceScrollBehavior(landing: boolean, reducedMotion: boolean): ScrollBehavior {
  return landing || reducedMotion ? "auto" : "smooth";
}

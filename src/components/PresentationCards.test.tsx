// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPresentationCard } from "../../shared/contracts";
import type { TemplateLayouts } from "../../shared/presentations";
import { PresentationCards } from "./PresentationCards";

const layouts: TemplateLayouts = {
  templateId: "demo",
  name: "Demo",
  aspectRatio: 16 / 9,
  patterns: {
    cover: { description: "Opening slide", slide: 1, shapes: [{ box: { x: 0.1, y: 0.4, w: 0.5, h: 0.2 }, fill: "text", label: "title", fontSize: 50 }] },
  },
};

const plan: ChatPresentationCard = {
  kind: "plan",
  id: "plan_1",
  templateId: "demo",
  templateName: "Demo",
  title: "City bikes",
  slides: [{ number: 1, layout: "cover", purpose: "Open the deck" }, { number: 2, layout: "missing-layout", purpose: "Say thanks" }],
  context: "{}",
};

const deck: ChatPresentationCard = {
  kind: "deck",
  id: "deck_1",
  templateId: "demo",
  templateName: "Demo",
  title: "City bikes",
  slides: [{ number: 1, layout: "cover", title: "City bikes" }],
  file: "/api/presentations/files/demo/deck_1.pptx",
  bytes: 2_200_000,
  warnings: ["slide 1 title: 40 characters, the budget is 36"],
  context: "{}",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(layouts)));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("presentation cards", () => {
  it("shows a plan's slides with their layouts and offers to create the one that is waiting", async () => {
    const onApprove = vi.fn();
    render(<PresentationCards cards={[plan]} pendingPlanId="plan_1" onApprove={onApprove} />);
    expect(screen.getByRole("heading", { name: "City bikes" })).toBeInTheDocument();
    expect(screen.getByText("Open the deck")).toBeInTheDocument();
    expect(screen.getByText(/2 slides · template Demo/)).toBeInTheDocument();
    // A layout the template has is drawn; one it no longer has leaves an empty frame.
    await waitFor(() => expect(screen.getByRole("img", { name: "Layout cover" })).toBeInTheDocument());
    expect(screen.queryByRole("img", { name: "Layout missing-layout" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Create presentation" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("offers no button on a plan that is not the one waiting", () => {
    render(<PresentationCards cards={[plan]} pendingPlanId="plan_2" onApprove={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Create presentation" })).toBeNull();
  });

  it("links a created deck to its file and lists what to check", () => {
    render(<PresentationCards cards={[deck]} onApprove={() => undefined} />);
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/presentations/files/demo/deck_1.pptx");
    expect(screen.getByText(/1 slides · 2\.1 MB · template Demo/)).toBeInTheDocument();
    expect(screen.getByText("1 thing to check in the file")).toBeInTheDocument();
    expect(screen.getByText("slide 1 title: 40 characters, the budget is 36")).toBeInTheDocument();
  });
});

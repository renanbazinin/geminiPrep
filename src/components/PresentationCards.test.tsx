// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("shows a plan's slides with pictures of their layouts and offers to create the one that is waiting", async () => {
    const onApprove = vi.fn();
    render(<PresentationCards cards={[plan]} pendingPlanId="plan_1" onApprove={onApprove} />);
    expect(screen.getByRole("heading", { name: "City bikes" })).toBeInTheDocument();
    expect(screen.getByText("Open the deck")).toBeInTheDocument();
    expect(screen.getByText(/2 slides · template Demo/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Layout cover" })).toHaveAttribute("src", "/api/presentations/templates/demo/patterns/cover.svg");
    await userEvent.click(screen.getByRole("button", { name: "Create presentation" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("draws a layout as boxes when the server has no picture of it", async () => {
    render(<PresentationCards cards={[plan]} onApprove={() => undefined} />);
    for (const picture of screen.getAllByRole("img")) fireEvent.error(picture);
    // The layout the template has is drawn from its shapes; one it no longer has leaves an empty frame.
    await waitFor(() => expect(document.querySelector("svg.slide-wireframe")).toBeInTheDocument());
    expect(screen.getByRole("img", { name: "Layout cover" }).tagName.toLowerCase()).toBe("svg");
    expect(screen.queryByRole("img", { name: "Layout missing-layout" })).toBeNull();
    expect(document.querySelector(".deck-thumb-empty")).toBeInTheDocument();
  });

  it("offers no button on a plan that is not the one waiting, or while an answer is being written", () => {
    const { rerender } = render(<PresentationCards cards={[plan]} pendingPlanId="plan_2" onApprove={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Create presentation" })).toBeNull();
    // A plan a deck was made from in the same answer is a plan, no longer one that waits.
    expect(screen.getByText("Plan")).toBeInTheDocument();
    rerender(<PresentationCards cards={[plan]} pendingPlanId="plan_1" canApprove={false} onApprove={() => undefined} />);
    expect(screen.getByText("Plan · not created yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create presentation" })).toBeNull();
  });

  it("links a created deck to its file, shows its slides and lists what to check", () => {
    render(<PresentationCards cards={[deck]} onApprove={() => undefined} />);
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/presentations/files/demo/deck_1.pptx");
    expect(screen.getByRole("img", { name: "Slide 1. City bikes" })).toHaveAttribute("src", "/api/presentations/files/demo/deck_1/slides/1.svg");
    expect(screen.getByRole("link", { name: "Open slide 1. City bikes" })).toHaveAttribute("href", "/api/presentations/files/demo/deck_1/slides/1.svg");
    expect(screen.getByText(/1 slides · 2\.1 MB · template Demo/)).toBeInTheDocument();
    expect(screen.getByText("1 thing to check in the file")).toBeInTheDocument();
    expect(screen.getByText("slide 1 title: 40 characters, the budget is 36")).toBeInTheDocument();
  });
});

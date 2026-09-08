import { describe, expect, it } from "vitest";
import { extractUnreadCount } from "@/lib/hooks/useNotifications";

describe("extractUnreadCount", () => {
  it("считает счётчик отказоустойчиво по разным формам ответа T07", () => {
    expect(extractUnreadCount({ unread_count: 3 })).toBe(3);
    expect(extractUnreadCount({ unread: 2 })).toBe(2);
    expect(extractUnreadCount([{ read: false }, { read: true }, { read: false }])).toBe(2);
    expect(extractUnreadCount({ items: [{ read: false }] })).toBe(1);
    expect(extractUnreadCount(null)).toBe(0);
    expect(extractUnreadCount(undefined)).toBe(0);
    expect(extractUnreadCount("unexpected")).toBe(0);
  });
});

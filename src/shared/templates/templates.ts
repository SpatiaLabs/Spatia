/**
 * Data-driven starter templates. Each template describes a small starter
 * canvas using the regular object model (notes, text, shapes, frames,
 * connections), so applying one is literally a new document with pre-placed
 * objects — everything stays editable, undoable and serializable.
 */
import type {
  CanvasObject,
  ConnectionObject,
  FrameObject,
  NoteObject,
  ShapeKind,
  ShapeObject,
  TextObject,
} from "../types/object.js";
import { SHAPE_DEFAULTS } from "../geometry/shapes.js";

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  accent: string;
  build(): CanvasObject[];
}

const C = {
  note: "#f0c33c",
  noteGreen: "#5cd69b",
  noteBlue: "#5cb8f2",
  notePurple: "#c07cf2",
  notePink: "#f28c5c",
  conn: "#91a3f0",
  connGreen: "#3ddc84",
  frame: "#2a6df5",
};

interface TextOpts {
  title?: string;
  text: string;
  color?: string;
  w?: number;
  h?: number;
}

interface ShapeOpts {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

interface ConnOpts {
  color?: string;
  arrowhead?: boolean;
}

/** Per-template incrementing builder producing fresh ids/z-order per apply. */
export class TemplateBuilder {
  private objs: CanvasObject[] = [];
  private z = 10;

  private uid(): string {
    return "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  result(): CanvasObject[] {
    return this.objs;
  }

  note(x: number, y: number, opts: TextOpts, w = 170, h = 120): NoteObject {
    const o: NoteObject = {
      type: "note",
      id: this.uid(),
      x,
      y,
      width: w,
      height: h,
      rotation: 0,
      zIndex: this.z++,
      locked: false,
      metadata: {},
      title: opts.title ?? "",
      text: opts.text,
      color: opts.color ?? C.note,
    };
    this.objs.push(o);
    return o;
  }

  text(x: number, y: number, text: string, w = 260, h = 90, fontSize = 24): TextObject {
    const o: TextObject = {
      type: "text",
      id: this.uid(),
      x,
      y,
      width: w,
      height: h,
      rotation: 0,
      zIndex: this.z++,
      locked: false,
      metadata: {},
      text,
      fontSize,
      bold: false,
      italic: false,
      align: "left",
    };
    this.objs.push(o);
    return o;
  }

  shape(x: number, y: number, w: number, h: number, kind: ShapeKind, opts: ShapeOpts = {}): ShapeObject {
    const d = SHAPE_DEFAULTS[kind];
    const o: ShapeObject = {
      type: "shape",
      kind,
      id: this.uid(),
      x,
      y,
      width: w,
      height: h,
      rotation: 0,
      zIndex: this.z++,
      locked: false,
      metadata: {},
      fill: opts.fill ?? d.fill,
      stroke: opts.stroke ?? d.stroke,
      strokeWidth: opts.strokeWidth ?? d.strokeWidth,
    };
    this.objs.push(o);
    return o;
  }

  frame(x: number, y: number, w: number, h: number, name: string, color = C.frame): FrameObject {
    const o: FrameObject = {
      type: "frame",
      id: this.uid(),
      x,
      y,
      width: w,
      height: h,
      rotation: 0,
      zIndex: this.z++,
      locked: false,
      metadata: {},
      name,
      color,
    };
    this.objs.push(o);
    return o;
  }

  conn(from: string, to: string, opts: ConnOpts = {}): ConnectionObject {
    const byId = (id: string): CanvasObject | undefined => this.objs.find((o) => o.id === id);
    const a = byId(from);
    const b = byId(to);
    const ax = a ? a.x + a.width / 2 : 0;
    const ay = a ? a.y + a.height / 2 : 0;
    const bx = b ? b.x + b.width / 2 : 0;
    const by = b ? b.y + b.height / 2 : 0;
    const minX = Math.min(ax, bx) - 4;
    const minY = Math.min(ay, by) - 4;
    const maxX = Math.max(ax, bx) + 4;
    const maxY = Math.max(ay, by) + 4;
    const o: ConnectionObject = {
      type: "connection",
      id: this.uid(),
      from,
      to,
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0,
      zIndex: this.z++,
      locked: false,
      metadata: {},
      arrowhead: opts.arrowhead ?? true,
      color: opts.color ?? C.conn,
      strokeWidth: 2,
      edgeFrom: "auto",
      edgeTo: "auto",
    };
    this.objs.push(o);
    return o;
  }
}

export const TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: "blank",
    name: "Blank canvas",
    description: "Start empty and build your own workspace.",
    accent: "#5b7cfa",
    build() {
      return [];
    },
  },
  {
    id: "brainstorming",
    name: "Brainstorming",
    description: "A central idea with a ring of related thoughts, connected back.",
    accent: "#f0c33c",
    build() {
      const b = new TemplateBuilder();
      b.note(-85, -130, { text: "Your big idea", color: C.note });
      const subjects = [
        { dx: -300, dy: -260, t: "Possibilities", c: C.noteBlue },
        { dx: 80, dy: -280, t: "What if…?", c: C.notePink },
        { dx: -320, dy: 60, t: "Problems", c: C.notePurple },
        { dx: 90, dy: 70, t: "Opportunities", c: C.noteGreen },
        { dx: -120, dy: -300, t: "Customers", c: C.noteBlue },
        { dx: 240, dy: -40, t: "Risks", c: C.notePink },
      ];
      const ids: string[] = [];
      for (const s of subjects) {
        ids.push(b.note(s.dx, s.dy, { text: "", title: s.t, color: s.c }, 150, 100).id);
      }
      return b.result();
    },
  },
  {
    id: "project-planning",
    name: "Project planning",
    description: "Phases across a timeline with tasks under each phase.",
    accent: "#2a6df5",
    build() {
      const b = new TemplateBuilder();
      const phases = [
        { x: -560, y: -140, name: "Plan", color: C.frame, tasks: ["Scope", "Milestones"] },
        { x: -180, y: -140, name: "Build", color: C.frame, tasks: ["Prototype", "Polish"] },
        { x: 200, y: -140, name: "Ship", color: C.frame, tasks: ["Review", "Launch"] },
      ];
      for (const p of phases) {
        b.frame(p.x, p.y, 340, 260, p.name, p.color);
        for (let i = 0; i < p.tasks.length; i++) {
          b.note(p.x + 30, p.y + 50 + i * 92, { text: "", title: p.tasks[i], color: C.note }, 280, 72);
        }
      }
      return b.result();
    },
  },
  {
    id: "mind-map",
    name: "Mind map",
    description: "A central topic branching into sub-topics.",
    accent: "#5cd69b",
    build() {
      const b = new TemplateBuilder();
      const topic = b.text(-180, -140, "Topic", 360, 120, 40);
      const branches = [
        { dx: 260, dy: -220, t: "Branch 1" },
        { dx: 260, dy: -40, t: "Branch 2" },
        { dx: 260, dy: 140, t: "Branch 3" },
      ];
      for (const br of branches) {
        const b1 = b.text(br.dx, br.dy, br.t, 240, 80);
        b.conn(topic.id, b1.id, { color: C.connGreen });
        const leaf = b.note(br.dx + 300, br.dy + 10, { text: "", title: "Idea", color: C.noteBlue }, 140, 90);
        b.conn(b1.id, leaf.id, { color: C.connGreen });
      }
      return b.result();
    },
  },
  {
    id: "study",
    name: "Study",
    description: "Flashcards for questions and answers.",
    accent: "#c07cf2",
    build() {
      const b = new TemplateBuilder();
      b.note(-260, -260, { title: "Study deck", text: "Test yourself — flip each card.", color: C.noteGreen }, 520, 120);
      const cards = [
        { q: "Who?", a: "Answer 1" },
        { q: "What?", a: "Answer 2" },
        { q: "When?", a: "Answer 3" },
        { q: "Where?", a: "Answer 4" },
      ];
      for (let i = 0; i < cards.length; i++) {
        const x = -360 + (i % 2) * 380;
        const y = -80 + Math.floor(i / 2) * 190;
        b.note(x, y, { title: cards[i].q, text: cards[i].a, color: C.notePurple }, 340, 160);
      }
      return b.result();
    },
  },
  {
    id: "notes",
    name: "Notes",
    description: "A focused set of meeting / scratch notes.",
    accent: "#f28c5c",
    build() {
      const b = new TemplateBuilder();
      b.note(-420, -300, { title: "Notes", text: "Keep everything you want to remember here.", color: C.note }, 840, 110);
      const notes = [
        { t: "Actions", body: "Follow up with the team this week.", c: C.note },
        { t: "Decisions", body: "We ship the first phase at the end of the month.", c: C.noteBlue },
        { t: "Questions", body: "Who owns the final review?", c: C.notePurple },
        { t: "Ideas", body: "Try out the new template workflow.", c: C.noteGreen },
        { t: "Parking lot", body: "Discuss animations in a later phase.", c: C.notePink },
      ];
      for (let i = 0; i < notes.length; i++) {
        const x = -420 + (i % 2) * 440;
        const y = -140 + Math.floor(i / 2) * 200;
        b.note(x, y, { title: notes[i].t, text: notes[i].body, color: notes[i].c }, 400, 170);
      }
      return b.result();
    },
  },
  {
    id: "product-planning",
    name: "Product planning",
    description: "A now / next / later roadmap with feature cards.",
    accent: "#5b7cfa",
    build() {
      const b = new TemplateBuilder();
      const lanes = [
        { x: -590, y: -140, name: "Now", items: ["Cut the MVP", "Fix crash", "Share beta"] },
        { x: -150, y: -140, name: "Next", items: ["Templates", "iOS sync"] },
        { x: 290, y: -140, name: "Later", items: ["AI helpers", "Public API"] },
      ];
      for (const lane of lanes) {
        b.frame(lane.x, lane.y, 440, 340, lane.name, C.frame);
        for (let i = 0; i < lane.items.length; i++) {
          b.note(lane.x + 30, lane.y + 60 + i * 92, { text: "", title: lane.items[i], color: C.note }, 380, 72);
        }
      }
      return b.result();
    },
  },
  {
    id: "personal",
    name: "Personal",
    description: "Goals, a habit grid and a simple daily planner.",
    accent: "#3ddc84",
    build() {
      const b = new TemplateBuilder();
      b.text(-300, -320, "My space", 360, 90, 36);
      b.note(-380, -160, { title: "Goals", text: "Write three things you want to achieve.", color: C.noteGreen }, 360, 160);
      b.note(60, -160, { title: "Today", text: "Plan your three most important tasks.", color: C.note }, 380, 160);
      b.frame(-380, 120, 820, 220, "Habits", C.frame);
      const days = ["M", "T", "W", "T", "F", "S", "S"];
      for (let i = 0; i < 7; i++) {
        b.shape(-330 + i * 100, 190, 70, 70, "rounded-rectangle", { fill: "#2a6df5", stroke: "#17256b" });
        b.note(-315 + i * 100, 210, { text: "", title: days[i], color: C.noteBlue }, 40, 30);
      }
      return b.result();
    },
  },
];

export function templateById(id: string): ProjectTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}
export type GenerationMode = "construction" | "clearspace";

export type ConstructionElement = "anchors" | "handles" | "outlines" | "circles" | "angles";
export type ClearspaceUnit = "logomark" | "pixels" | "centimeters" | "inches";
export type LineStyle = "solid" | "dashed";
export type LogoStyle = "outline" | "fill";
export type AnchorShape = "square" | "circle";
export type CanvasPreset = "dark" | "light";
export type GridStyle = "lines" | "dots";
export type ColorOverrideKey =
  | "backgroundColor"
  | "backgroundOpacity"
  | "gridColor"
  | "logoOutlineColor"
  | "logoFillColor"
  | "guideColor"
  | "anchorColor"
  | "handleColor";

export interface GenerationSettings {
  mode: GenerationMode;
  constructionElements: ConstructionElement[];
  clearspaceUnit: ClearspaceUnit;
  clearspaceValue: number;
  canvasPreset: CanvasPreset;
  backgroundColor: string;
  backgroundOpacity: number;
  gridEnabled: boolean;
  gridStyle: GridStyle;
  gridColor: string;
  gridOpacity: number;
  logoVisible: boolean;
  logoStyle: LogoStyle;
  logoOutlineColor: string;
  logoOutlineOpacity: number;
  logoFillColor: string;
  logoFillOpacity: number;
  guideColor: string;
  guideOpacity: number;
  lineStyle: LineStyle;
  strokeWidth: number;
  gridSize: number;
  anchorColor: string;
  anchorOpacity: number;
  anchorSize: number;
  anchorShape: AnchorShape;
  handleColor: string;
  handleOpacity: number;
  handleLineWeight: number;
  handleLength: number;
  handleSize: number;
  colorOverrides?: ColorOverrideKey[];
  lockGuidelines: boolean;
  replacePrevious: boolean;
}

export type PluginToUiMessage =
  | {
      type: "state";
      selectionCount: number;
      hasSelection: boolean;
      hasGeneratedOutput: boolean;
      hasGeneratedSelection: boolean;
      canUseCircles: boolean;
      usage: UsageState;
    }
  | {
      type: "generation-complete";
      groupName: string;
      appliedSettings: GenerationSettings;
      usage: UsageState;
    }
  | {
      type: "generation-error";
      message: string;
    };

export type UiToPluginMessage =
  | {
      type: "init";
    }
  | {
      type: "undo";
    }
  | {
      type: "redo";
      settings: GenerationSettings;
    }
  | {
      type: "generate";
      settings: GenerationSettings;
    };

export interface UsageState {
  paymentStatus: "qa" | "paid" | "unpaid" | "not-supported";
  freeLimit: number;
  freeUsed: number;
  canGenerate: boolean;
}

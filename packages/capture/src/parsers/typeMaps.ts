/** Native class → normalized element type. */

const IOS: Record<string, string> = {
  Application: "screen",
  Window: "container",
  Other: "container",
  Group: "container",
  ScrollView: "container",
  Button: "button",
  StaticText: "text",
  TextView: "text",
  Image: "image",
  Icon: "icon",
  TextField: "input",
  SecureTextField: "input",
  SearchField: "input",
  Switch: "toggle",
  Toggle: "toggle",
  Slider: "slider",
  Table: "list",
  CollectionView: "list",
  Cell: "cell",
  Link: "link",
  Tab: "tab",
  NavigationBar: "navbar",
  TabBar: "tabbar",
  Toolbar: "toolbar",
  SegmentedControl: "tab",
  PageIndicator: "other",
  Picker: "input",
  DatePicker: "input",
  Alert: "container",
  Sheet: "container",
  Keyboard: "container",
};

/** `XCUIElementTypeButton`, `Button`, or idb's AXRole-ish names. */
export function iosType(native: string | undefined): string {
  if (!native) return "container";
  const n = native.replace(/^XCUIElementType/, "").replace(/^AX/, "");
  return IOS[n] ?? "other";
}

const ANDROID: [RegExp, string][] = [
  [/(^|\.)(Button|ImageButton|MaterialButton|FloatingActionButton|Chip)$/, "button"],
  [/(^|\.)(EditText|TextInputEditText|AutoCompleteTextView|SearchView)$/, "input"],
  [/(^|\.)(CheckBox|Switch|SwitchCompat|SwitchMaterial|RadioButton|ToggleButton)$/, "toggle"],
  [/(^|\.)(SeekBar|Slider)$/, "slider"],
  [/(^|\.)(ImageView|AppCompatImageView)$/, "image"],
  [/(^|\.)(TextView|AppCompatTextView|MaterialTextView|CheckedTextView)$/, "text"],
  [/(^|\.)(RecyclerView|ListView|GridView|ScrollView|HorizontalScrollView|NestedScrollView)$/, "list"],
  [/(^|\.)(Toolbar|ActionBar)$/, "toolbar"],
  [/(^|\.)(TabLayout|BottomNavigationView|NavigationBarView)$/, "tabbar"],
  [/(^|\.)TabView$/, "tab"],
  [/(^|\.)(FrameLayout|LinearLayout|RelativeLayout|ConstraintLayout|CoordinatorLayout|ViewGroup|View|CardView|MaterialCardView|ComposeView|AndroidComposeView)$/, "container"],
];

export function androidType(native: string | undefined, attrs: { clickable?: boolean } = {}): string {
  if (!native) return "container";
  for (const [re, t] of ANDROID) if (re.test(native)) return t === "container" && attrs.clickable ? "button" : t;
  return attrs.clickable ? "button" : "other";
}

/**
 * Loomy Connect - Browser half
 *
 * Renders a credits badge in the conversation input area (conversation.input.right
 * slot), polling the plugin's status route for live credit information.
 *
 * - Renders "loomy 永久{permanent} 赠送{daily}" from the status route.
 * - Hidden unless the session's current model belongs to the Loomy provider.
 * - Read once on mount, again when the selected model changes, when a turn
 *   finishes, and on the ↻ beside the badge — never on a timer: every status
 *   GET also bills upstream, so the balance must not refresh behind the user.
 *
 * @module loomy-to-dsh/client
 */

window.__ModuleLoader__.load({
  id: "loomy-to-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var useRef = React.useRef;
    var useSyncExternalStore = React.useSyncExternalStore;

    var LOOMY_PROVIDER = "loomy";
    var LOOMY_STATUS_PATH = "/loomy-to-dsh/status";

﻿    //#region styles
    /**
     * The badge paints nothing of its own: transparent fill, no border, no hue —
     * only the theme's own text tokens, so it follows the system appearance.
     * The whole thing is the click target that re-reads the balance.
     */
    var creditsBadgeStyle = {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "2px 6px",
      margin: 0,
      border: "none",
      background: "transparent",
      font: "inherit",
      fontSize: 12,
      lineHeight: "20px",
      color: "var(--dsw-alias-text-primary)",
      cursor: "pointer",
      borderRadius: 6,
      whiteSpace: "nowrap",
      userSelect: "none",
    };

    /** While a read is in flight the seat only fades; it never recolours. */
    var busyBadgeStyle = Object.assign({}, creditsBadgeStyle, { opacity: 0.55 });

    /** The name reads one step quieter than the numbers, both from the theme. */
    var creditsLabelStyle = {
      color: "var(--dsw-alias-label-secondary)",
    };

    var creditsValueStyle = {
      color: "inherit",
    };
    //#endregion

    //#region fetchCredits
    /**
     * Fetch credits from the status route.
     */
    async function fetchCredits(signal) {
      try {
        var options = {
          headers: { Accept: "application/json" },
          cache: "no-store",
          credentials: "same-origin",
        };
        if (signal !== undefined) options.signal = signal;

        var response = await fetch(LOOMY_STATUS_PATH, options);

        if (!response.ok) {
          return { error: "API 错误: " + response.status };
        }

        var data = await response.json();

        if (data.credits) {
          return {
            permanent: data.credits.permanent,
            daily: data.credits.daily,
            total: data.credits.total,
            models: Array.isArray(data.models) ? data.models : [],
          };
        }

        if (data.creditsError) {
          return { error: data.creditsError.message };
        }

        return { error: "未找到积分信息" };
      } catch (error) {
        return { error: "网络错误: " + error.message };
      }
    }
    //#endregion

    //#region LoomyCreditsBadge
    /**
     * Credits badge component: "loomy 永久{permanent} 赠送{daily}", with a ↻
     * that re-reads on demand. Renders only while a Loomy model is selected.
     * Re-reads on mount, on model change, and when a turn finishes — there is
     * no interval, because every status GET also queries billing upstream.
     */
﻿    function LoomyCreditsBadge(props) {
      var directory = props.directory;
      var session = props.session === null || props.session === undefined ? NO_SESSION : props.session;
      var t = props.t;

      // Track the session's model selection so the badge follows the picker;
      // it renders only while a Loomy model is selected.
      var subscribeDirectory = useCallback(
        function (listener) {
          return directory.subscribe(listener);
        },
        [directory]
      );
      var readDirectory = useCallback(
        function () {
          return directory.getSnapshot();
        },
        [directory]
      );
      var selection = useSyncExternalStore(subscribeDirectory, readDirectory, readDirectory);
      var current = selection ? selection.current : null;
      var isLoomyModel =
        current !== null && current !== undefined && current.provider === LOOMY_PROVIDER;
      var currentModelId = current === null || current === undefined ? null : current.model;

      // Whether a turn is in flight. A turn ending is the cue to re-read the
      // balance, so it stays current without polling.
      var subscribeSession = useCallback(
        function (listener) {
          return session.subscribe(listener);
        },
        [session]
      );
      var readSession = useCallback(
        function () {
          return session.getSnapshot();
        },
        [session]
      );
      var sessionState = useSyncExternalStore(subscribeSession, readSession, readSession);
      var running = sessionState ? sessionState.running === true : false;

      var creditsState = useState(null);
      var credits = creditsState[0];
      var setCredits = creditsState[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var refreshRef = useRef(null);
      var wasRunningRef = useRef(running);

      // One read on mount, and again whenever the selected model changes.
      useEffect(
        function () {
          if (!isLoomyModel) {
            setCredits(null);
            setError(null);
            return undefined;
          }

          var controller = new AbortController();
          var cancelled = false;

          function read() {
            setBusy(true);
            fetchCredits(controller.signal)
              .then(function (result) {
                if (cancelled) return;
                if (result.error) {
                  setError(result.error);
                  setCredits(null);
                } else {
                  setCredits(result);
                  setError(null);
                }
                setBusy(false);
              })
              .catch(function () {
                if (cancelled) return;
                setBusy(false);
              });
          }

          refreshRef.current = read;
          read();

          return function () {
            cancelled = true;
            refreshRef.current = null;
            controller.abort();
          };
        },
        [isLoomyModel, currentModelId]
      );

      // A finished turn is the only automatic re-read: every status GET also
      // bills upstream, so the balance must never refresh on a timer.
      useEffect(
        function () {
          var wasRunning = wasRunningRef.current;
          wasRunningRef.current = running;
          if (!isLoomyModel) return;
          if (wasRunning && !running && refreshRef.current !== null) refreshRef.current();
        },
        [running, isLoomyModel]
      );

﻿      // Hidden unless the current model belongs to Loomy.
      if (!isLoomyModel) return null;

      // The badge is itself the refresh control: clicking it re-reads the balance.
      function refresh() {
        if (refreshRef.current !== null) refreshRef.current();
      }

      var seatStyle = busy ? busyBadgeStyle : creditsBadgeStyle;

      // Loading state
      if (!credits && !error) {
        return React.createElement(
          "button",
          {
            type: "button",
            onClick: refresh,
            disabled: busy,
            title: "正在读取 loomy 积分",
            "aria-label": "刷新 loomy 积分",
            style: seatStyle,
          },
          React.createElement("span", { style: creditsLabelStyle }, "loomy"),
          React.createElement("span", { style: creditsValueStyle }, "...")
        );
      }

      // Error state
      if (error) {
        return React.createElement(
          "button",
          {
            type: "button",
            onClick: refresh,
            disabled: busy,
            title: error + "（点击重试）",
            "aria-label": "刷新 loomy 积分",
            style: seatStyle,
          },
          React.createElement("span", { style: creditsLabelStyle }, "loomy"),
          React.createElement("span", { style: creditsValueStyle }, "积分读取失败")
        );
      }

      // Success state: loomy 永久{permanent} 赠送{daily}
      return React.createElement(
        "button",
        {
          type: "button",
          onClick: refresh,
          disabled: busy,
          title:
            "loomy 永久 " +
            credits.permanent +
            "，赠送 " +
            credits.daily +
            "，合计 " +
            credits.total +
            "（点击刷新）",
          "aria-label": "刷新 loomy 积分",
          style: seatStyle,
        },
        React.createElement("span", { style: creditsLabelStyle }, "loomy"),
        React.createElement("span", { style: creditsValueStyle }, "永久" + credits.permanent),
        React.createElement("span", { style: creditsValueStyle }, "赠送" + credits.daily)
      );
    }
    //#endregion

    //#region apply
    /**
     * Register the conversation.input.right slot.
     */
    function apply(ctx) {
      ctx.inject(["modelDirectories", "sessions"], function (scope) {
        scope.slots.inject("conversation.input.right", function () {
          return scope.slots.register(
            {
              name: "conversation.input.right",
              id: "loomy-credits",
              order: 10,
              inject: function (sessionId) {
                // The Session binding carries the running flag the badge watches
                // for a finished turn; a missing binding only costs that cue.
                var session = null;
                try {
                  var binding = scope.sessions.binding(sessionId);
                  if (binding !== undefined && binding !== null) session = binding.session;
                } catch (_error) {
                  session = null;
                }
                return {
                  directory: scope.modelDirectories.directoryFor(sessionId).store,
                  session: session,
                  t: null,
                };
              },
            },
            LoomyCreditsBadge
          );
        });
      });
    }
    //#endregion

    /**
     * Client services this bundle needs. Without an exported `inject`, `ctx.slots`
     * is not wired up and every `slots.inject(...)` below silently never fires.
     */
    var inject = ["slots"];

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});

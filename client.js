/**
 * Loomy Connect - Browser half
 *
 * Renders a credits badge in the conversation input area (conversation.input.right
 * slot), polling the plugin's status route for live credit information.
 *
 * - Free models (rate = 0): query once, show "免费", stop polling
 * - Paid models (rate > 0): poll every 5 minutes
 *
 * @module dsh-loomy-connect/client
 */

window.__ModuleLoader__.load({
  id: "loomy-to-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var useState = React.useState;
    var useEffect = React.useEffect;

    var LOOMY_STATUS_PATH = "/loomy-to-dsh/status";

    //#region styles
    var creditsBadgeStyle = {
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 12px",
      borderRadius: 999,
      fontSize: 12,
      lineHeight: "20px",
      background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
      color: "var(--dsw-alias-text-primary)",
      border: "1px solid var(--dsw-alias-state-success, rgba(34, 160, 107, 0.3))",
    };

    var creditsLabelStyle = {
      color: "var(--dsw-alias-label-secondary)",
      fontWeight: 500,
    };

    var creditsValueStyle = {
      color: "var(--dsw-alias-text-primary)",
      fontWeight: 600,
    };

    var errorBadgeStyle = {
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 12px",
      borderRadius: 999,
      fontSize: 12,
      lineHeight: "20px",
      background: "var(--dsw-alias-state-warning-subtle, rgba(217, 119, 6, 0.12))",
      color: "var(--dsw-alias-text-primary)",
      border: "1px solid var(--dsw-alias-state-warning, rgba(217, 119, 6, 0.3))",
    };

    var freeBadgeStyle = {
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 12px",
      borderRadius: 999,
      fontSize: 12,
      lineHeight: "20px",
      background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
      color: "var(--dsw-alias-text-primary)",
      border: "1px solid var(--dsw-alias-state-success, rgba(34, 160, 107, 0.3))",
    };
    //#endregion

    //#region fetchCredits
    /**
     * Fetch credits from the status route.
     */
    async function fetchCredits() {
      try {
        var response = await fetch(LOOMY_STATUS_PATH, {
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          return { error: "API 错误: " + response.status };
        }

        var data = await response.json();

        if (data.credits) {
          return {
            permanent: data.credits.permanent,
            daily: data.credits.daily,
            total: data.credits.total,
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
     * Credits badge component.
     * - Free models (rate = 0): query once, show "免费", stop polling
     * - Paid models (rate > 0): poll every 5 minutes
     */
    function LoomyCreditsBadge(props) {
      var model = props.model;
      var t = props.t;
      var creditsState = useState(null);
      var credits = creditsState[0];
      var setCredits = creditsState[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      // Check if current model is free
      var modelRate = model ? model.rate : undefined;
      var isFreeModel = modelRate === 0 || modelRate === undefined;

      useEffect(function () {
        var isCancelled = false;

        async function queryOnce() {
          var result = await fetchCredits();

          if (isCancelled) return;

          if (result.error) {
            setError(result.error);
            setCredits(null);
          } else {
            setCredits(result);
            setError(null);
          }
        }

        queryOnce();

        // Only set up interval for paid models
        if (!isFreeModel) {
          var interval = setInterval(queryOnce, 5 * 60 * 1000);

          return function () {
            isCancelled = true;
            clearInterval(interval);
          };
        }

        return function () {
          isCancelled = true;
        };
      }, [isFreeModel]);

      // Free model: show "免费" badge, no polling
      if (isFreeModel && credits) {
        return React.createElement(
          "div",
          { style: freeBadgeStyle },
          React.createElement("span", { style: creditsValueStyle }, t ? t("freeModel") : "免费")
        );
      }

      // Loading state
      if (!credits && !error) {
        return React.createElement(
          "div",
          { style: creditsBadgeStyle },
          React.createElement("span", { style: creditsLabelStyle }, t ? t("credits") : "积分"),
          React.createElement("span", { style: creditsValueStyle }, "...")
        );
      }

      // Error state
      if (error) {
        return React.createElement(
          "div",
          { style: errorBadgeStyle, title: error },
          React.createElement("span", { style: creditsLabelStyle }, t ? t("creditsError") : "积分错误"),
          React.createElement(
            "span",
            { style: creditsValueStyle },
            error.length > 20 ? error.slice(0, 20) + "..." : error
          )
        );
      }

      // Success state (paid model)
      return React.createElement(
        "div",
        { style: creditsBadgeStyle, title: "永久积分: " + credits.permanent + ", 每日赠送: " + credits.daily },
        React.createElement("span", { style: creditsLabelStyle }, t ? t("credits") : "积分"),
        React.createElement("span", { style: creditsValueStyle }, credits.total)
      );
    }
    //#endregion

    //#region apply
    /**
     * Register the conversation.input.right slot.
     */
    function apply(ctx) {
      ctx.inject(["modelDirectories"], function (scope) {
        scope.slots.inject("conversation.input.right", function () {
          return scope.slots.register(
            {
              name: "conversation.input.right",
              id: "loomy-credits",
              order: 10,
              inject: function (sessionId) {
                var directory = scope.modelDirectories.directoryFor(sessionId).store;
                var currentModel = directory.current;
                return {
                  model: currentModel,
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

    exports.apply = apply;
    return module.exports;
  },
});

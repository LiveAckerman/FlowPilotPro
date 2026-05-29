(function attachBackgroundAutoRunController(root, factory) {
  root.MultiPageBackgroundAutoRunController = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundAutoRunControllerModule() {
  // 「所有接码平台候选均未获取到手机号 / NO_NUMBERS」属于运营商号池临时空号 ——
  // 是接码平台外部的事，跟当前账号无关，多等几秒重抓基本能恢复。所以无论 autoRunSkipFailures
  // 是否开启，都按这个上限本轮自动重试；超过上限再让本轮失败、进下一轮。
  const PHONE_NO_SUPPLY_PER_ROUND_RETRY_CAP = 10;

  // 「页面/会话临时问题」型失败：停留在已登录 ChatGPT 首页（step 2 守卫）、或内容脚本因页面
  // 跳转/刷新断连未恢复。这类失败跟账号无关，下一轮 step 1 会清 cookie + 全新打开页面，
  // 恢复概率很高。因此即使没开自动重试，也只跳过当前轮、继续下一轮，而不是终止整段自动运行。
  function isRoundSkippableEntryFailure(message) {
    const text = String(message || '').trim();
    if (!text) return false;
    return /检测到当前停留在已登录\s*ChatGPT\s*首页|已阻止自动跳过步骤\s*3\/4\/5|页面刚完成跳转或刷新，内容脚本还没有重新接回/i.test(text);
  }

  function createAutoRunController(deps = {}) {
    const {
      addLog,
      appendAccountRunRecord,
      AUTO_RUN_MAX_RETRIES_PER_ROUND,
      AUTO_RUN_RETRY_DELAY_MS,
      AUTO_RUN_TIMER_KIND_BEFORE_RETRY,
      AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS,
      broadcastAutoRunStatus,
      broadcastStopToContentScripts,
      buildFreshAutoRunKeepState,
      cancelPendingCommands,
      clearStopRequest,
      createAutoRunSessionId,
      ensureHotmailMailboxReadyForAutoRunRound,
      getAutoRunStatusPayload,
      getErrorMessage,
      getFirstUnfinishedNodeId,
      getPendingAutoRunTimerPlan,
      getRunningNodeIds,
      getState,
      hasSavedNodeProgress,
      isAddPhoneAuthFailure,
      isGpcTaskEndedFailure,
      isKiroProxyFailure,
      isPhoneSmsPlatformRateLimitFailure,
      isPlusCheckoutNonFreeTrialFailure,
      isRestartCurrentAttemptError,
      isStep4Route405RecoveryLimitFailure,
      isSignupUserAlreadyExistsFailure,
      isSignupUnsupportedCountryFailure,
      isStopError,
      launchAutoRunTimerPlan,
      normalizeAutoRunFallbackThreadIntervalMinutes,
      persistAutoRunTimerPlan,
      resetState,
      runAutoSequenceFromNode,
      runtime,
      setState,
      sleepWithStop,
      throwIfAutoRunSessionStopped,
      waitForRunningNodesToFinish,
    } = deps;

    function getRunningWorkflowNodes(state = {}) {
      if (typeof getRunningNodeIds === 'function') {
        return getRunningNodeIds(state.nodeStatuses || {}, state);
      }
      return [];
    }

    function getFirstUnfinishedWorkflowNode(state = {}) {
      if (typeof getFirstUnfinishedNodeId === 'function') {
        return getFirstUnfinishedNodeId(state.nodeStatuses || {}, state);
      }
      return null;
    }

    function hasSavedWorkflowProgress(state = {}) {
      if (typeof hasSavedNodeProgress === 'function') {
        return hasSavedNodeProgress(state.nodeStatuses || {}, state);
      }
      return false;
    }

    async function waitForRunningWorkflowNodesToFinish(payload = {}) {
      if (typeof waitForRunningNodesToFinish === 'function') {
        return waitForRunningNodesToFinish(payload);
      }
      return getState();
    }

    async function runAutoSequenceFromWorkflowNode(startNodeId, context = {}) {
      if (typeof runAutoSequenceFromNode === 'function') {
        return runAutoSequenceFromNode(startNodeId, context);
      }
      throw new Error('自动运行节点执行器未接入。');
    }

    function buildFreshStartStateSnapshot(state = {}) {
      return {
        ...(state || {}),
        currentNodeId: '',
        nodeStatuses: {},
        stepStatuses: {},
      };
    }

    function resolveFreshStartNodeId(state = {}) {
      const freshState = buildFreshStartStateSnapshot(state);
      return String(getFirstUnfinishedWorkflowNode(freshState) || '').trim();
    }

    function buildFreshAttemptKeepState(state = {}, context = {}) {
      if (typeof buildFreshAutoRunKeepState === 'function') {
        const helperPatch = buildFreshAutoRunKeepState(state, context);
        if (helperPatch && typeof helperPatch === 'object' && !Array.isArray(helperPatch)) {
          return {
            ...helperPatch,
          };
        }
      }

      return {
        activeFlowId: state.activeFlowId,
        flowId: state.flowId || state.activeFlowId,
        targetId: state.targetId,
        vpsUrl: state.vpsUrl,
        vpsPassword: state.vpsPassword,
        customPassword: state.customPassword,
        plusModeEnabled: state.plusModeEnabled,
        plusPaymentMethod: state.plusPaymentMethod,
        phoneVerificationEnabled: state.phoneVerificationEnabled,
        phoneSignupReloginAfterBindEmailEnabled: state.phoneSignupReloginAfterBindEmailEnabled,
        paypalEmail: state.paypalEmail,
        paypalPassword: state.paypalPassword,
        kiroRsUrl: state.kiroRsUrl,
        kiroRsKey: state.kiroRsKey,
        autoRunSkipFailures: state.autoRunSkipFailures,
        autoRunFallbackThreadIntervalMinutes: state.autoRunFallbackThreadIntervalMinutes,
        autoRunDelayEnabled: state.autoRunDelayEnabled,
        autoRunDelayMinutes: state.autoRunDelayMinutes,
        autoStepDelaySeconds: state.autoStepDelaySeconds,
        stepExecutionRangeByFlow: state.stepExecutionRangeByFlow,
        signupMethod: state.signupMethod,
        mailProvider: state.mailProvider,
        emailGenerator: state.emailGenerator,
        gmailBaseEmail: state.gmailBaseEmail,
        mail2925BaseEmail: state.mail2925BaseEmail,
        currentMail2925AccountId: state.currentMail2925AccountId,
        emailPrefix: state.emailPrefix,
        inbucketHost: state.inbucketHost,
        inbucketMailbox: state.inbucketMailbox,
        cloudflareDomain: state.cloudflareDomain,
        cloudflareDomains: state.cloudflareDomains,
        reusablePhoneActivation: state.reusablePhoneActivation,
      };
    }

    function buildFreshAttemptLogCarryover(state = {}, context = {}) {
      const targetRun = Math.max(1, Math.floor(Number(context?.targetRun) || 1));
      const attemptRun = Math.max(1, Math.floor(Number(context?.attemptRun) || 1));
      if (targetRun <= 1 && attemptRun <= 1) {
        return [];
      }

      const logs = Array.isArray(state?.logs) ? state.logs : [];
      return logs
        .filter((entry) => entry && typeof entry === 'object' && String(entry.message || '').trim())
        .slice(-80)
        .map((entry) => ({
          message: String(entry.message || ''),
          level: entry.level || 'info',
          timestamp: Number(entry.timestamp) || Date.now(),
          step: Number.isInteger(Number(entry.step)) && Number(entry.step) > 0 ? Number(entry.step) : null,
          stepKey: String(entry.stepKey || '').trim(),
          nodeId: String(entry.nodeId || '').trim(),
        }));
    }

    function createAutoRunRoundSummary(round) {
      return {
        round,
        status: 'pending',
        attempts: 0,
        failureReasons: [],
        finalFailureReason: '',
      };
    }

    function normalizeAutoRunRoundSummary(summary, round) {
      const base = createAutoRunRoundSummary(round);
      if (!summary || typeof summary !== 'object') {
        return base;
      }

      const status = String(summary.status || '').trim().toLowerCase();
      return {
        round,
        status: ['pending', 'success', 'failed'].includes(status) ? status : base.status,
        attempts: Math.max(0, Math.floor(Number(summary.attempts) || 0)),
        failureReasons: Array.isArray(summary.failureReasons)
          ? summary.failureReasons.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
        finalFailureReason: String(summary.finalFailureReason || '').trim(),
      };
    }

    function buildAutoRunRoundSummaries(totalRuns, rawSummaries = []) {
      return Array.from({ length: totalRuns }, (_, index) => normalizeAutoRunRoundSummary(rawSummaries[index], index + 1));
    }

    function serializeAutoRunRoundSummaries(totalRuns, roundSummaries = []) {
      return buildAutoRunRoundSummaries(totalRuns, roundSummaries).map((summary) => ({
        ...summary,
        failureReasons: [...summary.failureReasons],
      }));
    }

    function getAutoRunRoundRetryCount(summary) {
      return Math.max(0, Number(summary?.attempts || 0) - 1);
    }

    function normalizeRecordNode(value = '') {
      return String(value || '').trim();
    }

    function extractNodeFromRecordStatus(status = '') {
      const match = String(status || '').trim().match(/^node:([^:]+):(failed|stopped)$/i);
      return match ? normalizeRecordNode(match[1]) : '';
    }

    function getKnownNodeIdsFromState(state = {}) {
      const ids = new Set();
      for (const key of Object.keys(state?.nodeStatuses || {})) {
        const nodeId = normalizeRecordNode(key);
        if (nodeId) {
          ids.add(nodeId);
        }
      }

      const currentNodeId = normalizeRecordNode(state?.currentNodeId);
      if (currentNodeId) {
        ids.add(currentNodeId);
      }

      return Array.from(ids);
    }

    function inferRecordNodeFromState(state = {}, preferredStatuses = []) {
      const statuses = state?.nodeStatuses || {};
      const preferredStatusSet = new Set(preferredStatuses.map((item) => String(item || '').trim()).filter(Boolean));
      const nodeIds = getKnownNodeIdsFromState(state);
      const currentNodeId = normalizeRecordNode(state?.currentNodeId);

      if (currentNodeId && preferredStatusSet.has(String(statuses[currentNodeId] || '').trim())) {
        return currentNodeId;
      }

      const matchingNodes = nodeIds.filter((nodeId) => preferredStatusSet.has(String(statuses[nodeId] || '').trim()));
      if (matchingNodes.length) {
        return matchingNodes[matchingNodes.length - 1];
      }

      if (currentNodeId) {
        const currentStatus = String(statuses[currentNodeId] || '').trim();
        if (!['', 'pending', 'completed', 'manual_completed', 'skipped'].includes(currentStatus)) {
          return currentNodeId;
        }
      }

      return '';
    }

    function inferRecordNodeFromError(errorLike = null, state = {}) {
      if (!errorLike || typeof errorLike !== 'object') {
        return '';
      }

      return normalizeRecordNode(errorLike.failedNodeId)
        || normalizeRecordNode(errorLike.nodeId)
        || normalizeRecordNode(errorLike.currentNodeId);
    }

    function resolveAutoRunAccountRecordStatus(status, state = {}, errorLike = null) {
      const normalizedStatus = String(status || '').trim().toLowerCase();
      const explicitNode = extractNodeFromRecordStatus(status);
      if (explicitNode) {
        return `node:${explicitNode}:${normalizedStatus.endsWith(':stopped') ? 'stopped' : 'failed'}`;
      }
      if (normalizedStatus === 'failed') {
        const failedNode = inferRecordNodeFromError(errorLike, state)
          || inferRecordNodeFromState(state, ['failed', 'running']);
        return failedNode ? `node:${failedNode}:failed` : status;
      }

      if (normalizedStatus === 'stopped') {
        const stoppedNode = inferRecordNodeFromError(errorLike, state)
          || inferRecordNodeFromState(state, ['stopped', 'running']);
        return stoppedNode ? `node:${stoppedNode}:stopped` : status;
      }

      return status;
    }

    function formatAutoRunFailureReasons(reasons = []) {
      if (!Array.isArray(reasons) || !reasons.length) {
        return '未知错误';
      }

      const counts = new Map();
      for (const reason of reasons) {
        const normalized = String(reason || '').trim() || '未知错误';
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
      }

      return Array.from(counts.entries())
        .map(([reason, count]) => (count > 1 ? `${reason}（${count}次）` : reason))
        .join('；');
    }

    function isPhoneNumberSupplyExhaustedFailure(errorLike) {
      const message = String(
        typeof errorLike === 'string'
          ? errorLike
          : (errorLike?.message || errorLike || '')
      ).trim();
      if (!message) {
        return false;
      }
      const hasGlobalNoSupplySignal = /Step\s*9:\s*all\s+provider\s+candidates\s+failed\s+to\s+acquire\s+number|(?:HeroSMS|5sim|NexSMS)\s+no\s+numbers\s+available\s+across|no\s+numbers\s+within\s+maxPrice|no\s+free\s+phones|numbers?\s+not\s+found/i.test(message);
      if (!hasGlobalNoSupplySignal) {
        return false;
      }
      const hasRecoverableStep9RotationSignal = /phone\s+verification\s+did\s+not\s+succeed\s+after\s+\d+\s+number\s+replacements|sms_timeout_after_|route_405_retry_loop|resend_throttled|activation_not_found|order\s+not\s+found/i.test(message);
      if (hasRecoverableStep9RotationSignal) {
        return false;
      }
      return true;
    }

    function shouldKeepCustomMailProviderPoolEmail(state = {}) {
      return String(state?.mailProvider || '').trim().toLowerCase() === 'custom'
        && Array.isArray(state?.customMailProviderPool)
        && state.customMailProviderPool.length > 0;
    }

    function isPhoneNumberSupplyExhaustedFailure(error) {
      const text = String(
        typeof getErrorMessage === 'function'
          ? getErrorMessage(error)
          : (error?.message || error || '')
      ).trim();
      if (!text) {
        return false;
      }
      return /no\s+numbers\s+available\s+across|all provider candidates failed to acquire number|no\s+free\s+phones|numbers?\s+not\s+found|no\s+numbers\s+within\s+maxprice|countries\s+are\s+empty|均无可用号码|暂无可用号码|无可用号码|接码号池暂无|\bNO_NUMBERS\b/i.test(text);
    }

    async function logAutoRunFinalSummary(totalRuns, roundSummaries = []) {
      const summaries = buildAutoRunRoundSummaries(totalRuns, roundSummaries);
      const successRounds = summaries.filter((item) => item.status === 'success');
      const failedRounds = summaries.filter((item) => item.status === 'failed');
      const pendingRounds = summaries.filter((item) => item.status === 'pending');

      await addLog('=== 自动运行汇总 ===', failedRounds.length ? 'warn' : 'ok');
      await addLog(
        `总轮数：${totalRuns}；成功：${successRounds.length}；失败：${failedRounds.length}；未完成：${pendingRounds.length}`,
        failedRounds.length ? 'warn' : 'ok'
      );

      if (successRounds.length) {
        await addLog(
          `成功轮次：${successRounds
            .map((item) => `第 ${item.round} 轮（重试 ${getAutoRunRoundRetryCount(item)} 次）`)
            .join('；')}`,
          'ok'
        );
      }

      if (failedRounds.length) {
        await addLog(
          `失败轮次：${failedRounds
            .map((item) => {
              const retryCount = getAutoRunRoundRetryCount(item);
              const finalReason = item.finalFailureReason || item.failureReasons[item.failureReasons.length - 1] || '未知错误';
              const reasonSummary = formatAutoRunFailureReasons(item.failureReasons);
              return !reasonSummary || reasonSummary === finalReason
                ? `第 ${item.round} 轮（重试 ${retryCount} 次，最终原因：${finalReason}）`
                : `第 ${item.round} 轮（重试 ${retryCount} 次，最终原因：${finalReason}；失败记录：${reasonSummary}）`;
            })
            .join('；')}`,
          'error'
        );
      }

      if (pendingRounds.length) {
        await addLog(
          `未完成轮次：${pendingRounds.map((item) => `第 ${item.round} 轮`).join('；')}`,
          'warn'
        );
      }
    }

    async function skipAutoRunCountdown() {
      const state = await getState();
      const plan = getPendingAutoRunTimerPlan(state);
      if (!plan || state.autoRunPhase !== 'waiting_interval') {
        return false;
      }

      return launchAutoRunTimerPlan('manual', {
        expectedKinds: [
          AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS,
          AUTO_RUN_TIMER_KIND_BEFORE_RETRY,
        ],
      });
    }

    async function waitBetweenAutoRunRounds(targetRun, totalRuns, roundSummary, options = {}) {
      const { autoRunSkipFailures = false, roundSummaries = [] } = options;
      if (totalRuns <= 1 || targetRun >= totalRuns) {
        return false;
      }

      const fallbackThreadIntervalMinutes = normalizeAutoRunFallbackThreadIntervalMinutes(
        (await getState()).autoRunFallbackThreadIntervalMinutes
      );
      if (fallbackThreadIntervalMinutes <= 0) {
        return false;
      }

      const currentRuntime = runtime.get();
      const statusLabel = roundSummary?.status === 'failed' ? '失败' : '完成';
      await addLog(
        `线程间隔：第 ${targetRun}/${totalRuns} 轮已${statusLabel}，等待 ${fallbackThreadIntervalMinutes} 分钟后开始下一轮。`,
        'info'
      );
      await persistAutoRunTimerPlan({
        kind: AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS,
        fireAt: Date.now() + fallbackThreadIntervalMinutes * 60 * 1000,
        currentRun: targetRun,
        totalRuns,
        attemptRun: currentRuntime.autoRunAttemptRun,
        autoRunSessionId: currentRuntime.autoRunSessionId,
        autoRunSkipFailures,
        roundSummaries,
        countdownTitle: '线程间隔中',
        countdownNote: `第 ${Math.min(targetRun + 1, totalRuns)}/${totalRuns} 轮即将开始`,
      }, {
        autoRunSkipFailures,
        autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
      });
      runtime.set({ autoRunActive: false });
      return true;
    }

    async function waitBeforeAutoRunRetry(targetRun, totalRuns, nextAttemptRun, options = {}) {
      const { autoRunSkipFailures = false, roundSummaries = [] } = options;
      const fallbackThreadIntervalMinutes = normalizeAutoRunFallbackThreadIntervalMinutes(
        (await getState()).autoRunFallbackThreadIntervalMinutes
      );
      if (fallbackThreadIntervalMinutes <= 0) {
        return false;
      }

      await addLog(
        `线程间隔：等待 ${fallbackThreadIntervalMinutes} 分钟后开始第 ${targetRun}/${totalRuns} 轮第 ${nextAttemptRun} 次尝试。`,
        'info'
      );
      await persistAutoRunTimerPlan({
        kind: AUTO_RUN_TIMER_KIND_BEFORE_RETRY,
        fireAt: Date.now() + fallbackThreadIntervalMinutes * 60 * 1000,
        currentRun: targetRun,
        totalRuns,
        attemptRun: nextAttemptRun,
        autoRunSessionId: runtime.get().autoRunSessionId,
        autoRunSkipFailures,
        roundSummaries,
        countdownTitle: '线程间隔中',
        countdownNote: `第 ${targetRun}/${totalRuns} 轮第 ${nextAttemptRun} 次尝试即将开始`,
      }, {
        autoRunSkipFailures,
        autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
      });
      runtime.set({ autoRunActive: false });
      return true;
    }

    async function handleAutoRunLoopUnhandledError(error) {
      const currentRuntime = runtime.get();
      console.error('Auto run loop crashed:', error);
      if (!isStopError(error)) {
        await addLog(`自动运行异常终止：${getErrorMessage(error) || '未知错误'}`, 'error');
      }

      runtime.set({ autoRunActive: false, autoRunSessionId: 0 });
      await broadcastAutoRunStatus('stopped', {
        currentRun: currentRuntime.autoRunCurrentRun,
        totalRuns: currentRuntime.autoRunTotalRuns,
        attemptRun: currentRuntime.autoRunAttemptRun,
        sessionId: 0,
      }, {
        autoRunSessionId: 0,
        autoRunTimerPlan: null,
        scheduledAutoRunPlan: null,
      });
      clearStopRequest();
    }

    function startAutoRunLoop(totalRuns, options = {}) {
      autoRunLoop(totalRuns, options).catch((error) => {
        handleAutoRunLoopUnhandledError(error).catch(() => {});
      });
    }

    async function autoRunLoop(totalRuns, options = {}) {
      let currentRuntime = runtime.get();
      if (currentRuntime.autoRunActive) {
        await addLog('自动运行已在进行中', 'warn');
        return;
      }

      let sessionId = Number.isInteger(options.autoRunSessionId) && options.autoRunSessionId > 0
        ? options.autoRunSessionId
        : 0;
      if (sessionId) {
        throwIfAutoRunSessionStopped(sessionId);
      } else {
        sessionId = createAutoRunSessionId();
      }

      clearStopRequest();
      runtime.set({
        autoRunActive: true,
        autoRunTotalRuns: totalRuns,
        autoRunCurrentRun: 0,
        autoRunAttemptRun: 0,
        autoRunSessionId: sessionId,
      });
      currentRuntime = runtime.get();

      const autoRunSkipFailures = Boolean(options.autoRunSkipFailures);
      const initialMode = options.mode === 'continue' ? 'continue' : 'restart';
      const resumeCurrentRun = Number.isInteger(options.resumeCurrentRun) && options.resumeCurrentRun > 0
        ? Math.min(totalRuns, options.resumeCurrentRun)
        : 1;
      const resumeAttemptRun = Number.isInteger(options.resumeAttemptRun) && options.resumeAttemptRun > 0
        ? Math.min(AUTO_RUN_MAX_RETRIES_PER_ROUND + 1, options.resumeAttemptRun)
        : 1;
      let continueCurrentOnFirstAttempt = initialMode === 'continue';
      let forceFreshTabsNextRun = false;
      let stoppedEarly = false;
      let parkedByTimer = false;
      const roundSummaries = buildAutoRunRoundSummaries(totalRuns, options.resumeRoundSummaries);

      if (continueCurrentOnFirstAttempt && resumeCurrentRun > 1) {
        for (let round = 1; round < resumeCurrentRun; round += 1) {
          const summary = roundSummaries[round - 1];
          if (summary.status === 'pending') {
            summary.status = 'success';
            if (!summary.attempts) {
              summary.attempts = 1;
            }
          }
        }
      }

      let successfulRuns = roundSummaries.filter((item) => item.status === 'success').length;
      const initialState = await getState();
      const initialPhase = continueCurrentOnFirstAttempt && getRunningWorkflowNodes(initialState).length
        ? 'waiting_step'
        : 'running';
      const showResumePosition = continueCurrentOnFirstAttempt || resumeCurrentRun > 1 || resumeAttemptRun > 1;

      await setState({
        autoRunSessionId: sessionId,
        autoRunSkipFailures,
        autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
        ...getAutoRunStatusPayload(initialPhase, {
          currentRun: showResumePosition ? resumeCurrentRun : 0,
          totalRuns,
          attemptRun: showResumePosition ? resumeAttemptRun : 0,
          sessionId,
        }),
      });

      for (let targetRun = resumeCurrentRun; targetRun <= totalRuns; targetRun += 1) {
        const roundSummary = roundSummaries[targetRun - 1];
        let roundRecordAppended = false;
        const resumingCurrentRound = continueCurrentOnFirstAttempt && targetRun === resumeCurrentRun;
        let attemptRun = resumingCurrentRound ? resumeAttemptRun : 1;
        let reuseExistingProgress = resumingCurrentRound;
        const currentRoundState = await getState();
        const keepSameEmailUntilAddPhone = autoRunSkipFailures && shouldKeepCustomMailProviderPoolEmail(currentRoundState);
        let maxAttemptsForRound = autoRunSkipFailures
          ? (keepSameEmailUntilAddPhone ? Number.MAX_SAFE_INTEGER : AUTO_RUN_MAX_RETRIES_PER_ROUND + 1)
          : Math.max(1, attemptRun);
        // NO_NUMBERS 重试不占用普通失败的 attempt 额度，单独计数；超过 cap 才本轮放弃 + 进下一轮。
        let phoneNoSupplyRetryCount = 0;

        while (attemptRun <= maxAttemptsForRound) {
          runtime.set({
            autoRunCurrentRun: targetRun,
            autoRunAttemptRun: attemptRun,
          });
          roundSummary.attempts = attemptRun;
          const attemptState = await getState();
          const defaultStartNodeId = resolveFreshStartNodeId(attemptState);
          let startNodeId = defaultStartNodeId;
          let useExistingProgress = false;

          if (reuseExistingProgress) {
            let currentState = attemptState;
            if (getRunningWorkflowNodes(currentState).length) {
              currentState = await waitForRunningWorkflowNodesToFinish({
                currentRun: targetRun,
                totalRuns,
                attemptRun,
              });
            }
            const resumeNodeId = getFirstUnfinishedWorkflowNode(currentState);
            if (resumeNodeId && hasSavedWorkflowProgress(currentState)) {
              startNodeId = resumeNodeId;
              useExistingProgress = true;
            } else if (hasSavedWorkflowProgress(currentState)) {
              await addLog('检测到当前流程已处理完成，本轮将改为从首个节点重新开始。', 'info');
            }
          }

          if (!useExistingProgress) {
            const prevState = attemptState;
            const keepSettings = {
              ...buildFreshAttemptKeepState(prevState, {
                targetRun,
                totalRuns,
                attemptRun,
                sessionId,
              }),
              autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              autoRunSessionId: sessionId,
              tabRegistry: {},
              sourceLastUrls: {},
              logs: buildFreshAttemptLogCarryover(prevState, { targetRun, attemptRun }),
              ...getAutoRunStatusPayload('running', { currentRun: targetRun, totalRuns, attemptRun, sessionId }),
            };
            await resetState();
            await setState(keepSettings);
            deps.chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => { });
            await sleepWithStop(500);
          } else {
            await setState({
              autoRunSessionId: sessionId,
              autoRunSkipFailures,
              autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              ...getAutoRunStatusPayload('running', { currentRun: targetRun, totalRuns, attemptRun, sessionId }),
            });
          }

          // 防御：useExistingProgress=false 时本应已 resetState 把 nodeStatuses 清成全 pending。
          // 若由于异常路径（如 BETWEEN_ROUNDS timer 复入 / mode='continue' 残留）仍带着上一轮的
          // completed/skipped 状态进入新一轮，必须当场强制清零，否则后续节点会被判定为已完成、
          // 整轮空跑后被误判为成功。
          if (!useExistingProgress) {
            const sanityState = await getState();
            const stalePairs = Object.entries(sanityState?.nodeStatuses || {})
              .filter(([, status]) => String(status || 'pending').trim() !== 'pending');
            if (stalePairs.length > 0) {
              const preview = stalePairs
                .slice(0, 5)
                .map(([id, status]) => `${id}=${status}`)
                .join(', ');
              await addLog(
                `自动运行：检测到第 ${targetRun}/${totalRuns} 轮第 ${attemptRun} 次尝试开始时仍残留 ${stalePairs.length} 个非 pending 节点状态（${preview}${stalePairs.length > 5 ? ' …' : ''}），将强制重置为 pending 后再开始执行。`,
                'warn'
              );
              const cleanedStatuses = Object.fromEntries(
                Object.keys(sanityState?.nodeStatuses || {}).map((nodeId) => [nodeId, 'pending'])
              );
              await setState({
                nodeStatuses: cleanedStatuses,
                currentNodeId: '',
              });
            }

            // 防御：同样的泄漏路径也会带过来「上一轮的注册邮箱」。新一轮第一次尝试，注册邮箱
            // 必须是空的 —— Hotmail/Luckmail/2925池/Duck/iCloud 等所有 provider 会在
            // submit-signup-email 之前各自重新分配 / 生成新邮箱；如果 state.email 还带着
            // 上一轮的值，`ensureAutoEmailReady` 第 12524 行的「if (currentState.email) return;」
            // 会直接复用旧邮箱，永远不会调到 Duck 去开新地址。这里强制清零并打日志记录泄漏来源。
            const sanityState2 = await getState();
            const staleEmail = String(sanityState2?.email || '').trim();
            const registrationStateLeak = sanityState2?.registrationEmailState
              && (
                String(sanityState2.registrationEmailState.current || '').trim()
                || String(sanityState2.registrationEmailState.previous || '').trim()
              );
            const step8VerificationLeak = String(sanityState2?.step8VerificationTargetEmail || '').trim();
            const bindEmailSubmittedLeak = Boolean(sanityState2?.bindEmailSubmitted);
            if (staleEmail || registrationStateLeak || step8VerificationLeak || bindEmailSubmittedLeak) {
              const leakReasons = [];
              if (staleEmail) leakReasons.push(`email=${staleEmail}`);
              if (registrationStateLeak) {
                const cur = String(sanityState2.registrationEmailState.current || '').trim();
                const prev = String(sanityState2.registrationEmailState.previous || '').trim();
                leakReasons.push(`registrationEmailState{current=${cur || '∅'},previous=${prev || '∅'}}`);
              }
              if (step8VerificationLeak) leakReasons.push(`step8VerificationTargetEmail=${step8VerificationLeak}`);
              if (bindEmailSubmittedLeak) leakReasons.push('bindEmailSubmitted=true');
              await addLog(
                `自动运行：检测到第 ${targetRun}/${totalRuns} 轮第 ${attemptRun} 次尝试开始时残留上一轮的注册邮箱状态（${leakReasons.join('；')}），将强制清零后再生成新邮箱。`,
                'warn'
              );
              await setState({
                email: null,
                registrationEmailState: {
                  current: '',
                  previous: '',
                  source: '',
                  updatedAt: 0,
                },
                step8VerificationTargetEmail: '',
                bindEmailSubmitted: false,
                loginVerificationRequestedAt: null,
                signupVerificationRequestedAt: null,
              });
            }
          }

          if (forceFreshTabsNextRun) {
            await addLog(`上一轮尝试已放弃，当前开始第 ${targetRun}/${totalRuns} 轮第 ${attemptRun} 次尝试。`, 'warn');
            forceFreshTabsNextRun = false;
          }

          const appendRoundRecordIfNeeded = async (status, reason = '', errorLike = null) => {
            if (roundRecordAppended) {
              return;
            }

            if (typeof appendAccountRunRecord !== 'function') {
              return;
            }

            const recordState = await getState();
            const recordStatus = resolveAutoRunAccountRecordStatus(status, recordState, errorLike);
            const record = await appendAccountRunRecord(recordStatus, recordState, reason);
            if (record) {
              roundRecordAppended = true;
            }
          };

          try {
            throwIfAutoRunSessionStopped(sessionId);
            await broadcastAutoRunStatus('running', {
              currentRun: targetRun,
              totalRuns,
              attemptRun,
              sessionId,
            });

            if (!useExistingProgress && startNodeId === defaultStartNodeId && typeof ensureHotmailMailboxReadyForAutoRunRound === 'function') {
              await ensureHotmailMailboxReadyForAutoRunRound({
                targetRun,
                totalRuns,
                attemptRun,
                sessionId,
              });
            }

            await runAutoSequenceFromWorkflowNode(startNodeId, {
              targetRun,
              totalRuns,
              attemptRuns: attemptRun,
              continued: useExistingProgress,
            });

            roundSummary.status = 'success';
            roundSummary.finalFailureReason = '';
            successfulRuns += 1;
            await setState({
              autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
            });
            await addLog(`=== 第 ${targetRun}/${totalRuns} 轮完成（第 ${attemptRun} 次尝试成功）===`, 'ok');
            break;
          } catch (err) {
            if (isStopError(err)) {
              stoppedEarly = true;
              await appendRoundRecordIfNeeded('stopped', getErrorMessage(err), err);
              await addLog(`第 ${targetRun}/${totalRuns} 轮已被用户停止`, 'warn');
              await broadcastAutoRunStatus('stopped', {
                currentRun: targetRun,
                totalRuns,
                attemptRun,
                sessionId: 0,
              });
              break;
            }

            const reason = getErrorMessage(err);
            roundSummary.failureReasons.push(reason);
            const blockedByPhoneSmsRateLimit = typeof isPhoneSmsPlatformRateLimitFailure === 'function'
              && isPhoneSmsPlatformRateLimitFailure(err);
            const blockedByPhoneNoSupply = !blockedByPhoneSmsRateLimit
              && isPhoneNumberSupplyExhaustedFailure(err);
            const blockedByAddPhone = !blockedByPhoneSmsRateLimit
              && !blockedByPhoneNoSupply
              && typeof isAddPhoneAuthFailure === 'function'
              && isAddPhoneAuthFailure(err);
            const blockedByPlusNonFreeTrial = typeof isPlusCheckoutNonFreeTrialFailure === 'function'
              && isPlusCheckoutNonFreeTrialFailure(err);
            const blockedByGpcTaskEnded = typeof isGpcTaskEndedFailure === 'function'
              ? isGpcTaskEndedFailure(err)
              : /GPC_TASK_ENDED::/i.test(err?.message || String(err || ''));
            const blockedBySignupUserAlreadyExists = typeof isSignupUserAlreadyExistsFailure === 'function'
              && !keepSameEmailUntilAddPhone
              && isSignupUserAlreadyExistsFailure(err);
            const blockedByStep4Route405 = typeof isStep4Route405RecoveryLimitFailure === 'function'
              && isStep4Route405RecoveryLimitFailure(err);
            const blockedByKiroProxy = typeof isKiroProxyFailure === 'function'
              && isKiroProxyFailure(err);
            const blockedByUnsupportedCountry = typeof isSignupUnsupportedCountryFailure === 'function'
              && isSignupUnsupportedCountryFailure(err);
            const canRetry = !blockedByAddPhone
              && !blockedByPhoneNoSupply
              && !blockedByPlusNonFreeTrial
              && !blockedByGpcTaskEnded
              && !blockedBySignupUserAlreadyExists
              && !blockedByStep4Route405
              && !blockedByKiroProxy
              && !blockedByUnsupportedCountry
              && autoRunSkipFailures
              && attemptRun < maxAttemptsForRound;

            await setState({
              autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
            });

            if (blockedByUnsupportedCountry) {
              roundSummary.status = 'failed';
              roundSummary.finalFailureReason = reason;
              await setState({
                autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              });
              await appendRoundRecordIfNeeded('failed', reason, err);
              cancelPendingCommands('当前轮因 OpenAI 区域受限（unsupported_country）已终止。');
              await broadcastStopToContentScripts();
              // 区域受限是 IP/VPN 层面的硬性拒绝，所有后续轮都会撞同样的墙，
              // 因此无论 autoRunSkipFailures 是否开启都直接停整段自动运行，
              // 并把 VPN 排查提示打到日志里给用户看。
              await addLog(
                `第 ${targetRun}/${totalRuns} 轮触发 OpenAI 区域限制（unsupported_country），无法通过重试/换号/换邮箱绕过，当前自动运行将停止。原因：${reason}`,
                'error'
              );
              await addLog(
                '请检查 VPN 是否已挂载到 OpenAI 支持的区域（建议美国干净住宅 IP），确认浏览器实际出口 IP 落在支持区域后再重新启动自动运行。',
                'warn'
              );
              stoppedEarly = true;
              await broadcastAutoRunStatus('stopped', {
                currentRun: targetRun,
                totalRuns,
                attemptRun,
                sessionId: 0,
              });
              break;
            }

            if (blockedByAddPhone) {
              roundSummary.status = 'failed';
              roundSummary.finalFailureReason = reason;
              await setState({
                autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              });
              await appendRoundRecordIfNeeded('failed', reason, err);
              cancelPendingCommands('当前轮因认证流程进入 add-phone 已终止。');
              await broadcastStopToContentScripts();
              if (!autoRunSkipFailures) {
                await addLog(
                  `第 ${targetRun}/${totalRuns} 轮触发 add-phone/手机号页，自动重试未开启，当前自动运行将停止。`,
                  'warn'
                );
                stoppedEarly = true;
                await broadcastAutoRunStatus('stopped', {
                  currentRun: targetRun,
                  totalRuns,
                  attemptRun,
                  sessionId: 0,
                });
                break;
              }

              await addLog(`第 ${targetRun}/${totalRuns} 轮触发 add-phone/手机号页，本轮将直接失败并跳过剩余重试。`, 'warn');
              await addLog(
                targetRun < totalRuns
                  ? `第 ${targetRun}/${totalRuns} 轮因 add-phone/手机号页提前结束，自动流程将继续下一轮。`
                  : `第 ${targetRun}/${totalRuns} 轮因 add-phone/手机号页提前结束，已无后续轮次，本次自动运行结束。`,
                'warn'
              );
              forceFreshTabsNextRun = true;
              break;
            }

            if (blockedByPhoneNoSupply) {
              // 接码号池临时空号是运营商外部状态，跟当前账号无关，多等几秒重抓就能恢复。
              // 不管 autoRunSkipFailures 是否开启，先在本轮内自动重试到上限。
              phoneNoSupplyRetryCount += 1;
              if (phoneNoSupplyRetryCount <= PHONE_NO_SUPPLY_PER_ROUND_RETRY_CAP) {
                await addLog(
                  `第 ${targetRun}/${totalRuns} 轮接码号池暂无可用号码（NO_NUMBERS），自动重试第 ${phoneNoSupplyRetryCount}/${PHONE_NO_SUPPLY_PER_ROUND_RETRY_CAP} 次。原因：${reason}`,
                  'warn'
                );
                cancelPendingCommands('接码号池暂无可用号码，准备重试当前轮。');
                await broadcastStopToContentScripts();
                forceFreshTabsNextRun = true;
                // 突破 maxAttemptsForRound 的 hard cap（autoRunSkipFailures=false 时它=1），
                // 让 while 循环还能转下去。NO_NUMBERS 走自己的 PHONE_NO_SUPPLY_PER_ROUND_RETRY_CAP，
                // 不挤普通失败的 attempt 额度。
                if (maxAttemptsForRound !== Number.MAX_SAFE_INTEGER && maxAttemptsForRound <= attemptRun) {
                  maxAttemptsForRound = attemptRun + 1;
                }
                attemptRun += 1;
                reuseExistingProgress = false;
                continue;
              }

              // 超过 cap → 本轮放弃 + 直接进下一轮，无论 autoRunSkipFailures 开没开。
              roundSummary.status = 'failed';
              roundSummary.finalFailureReason = reason;
              await setState({
                autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              });
              await appendRoundRecordIfNeeded('failed', reason, err);
              cancelPendingCommands('当前轮因接码号池暂无可用号码已终止。');
              await broadcastStopToContentScripts();
              await addLog(
                `第 ${targetRun}/${totalRuns} 轮接码号池连续 ${PHONE_NO_SUPPLY_PER_ROUND_RETRY_CAP} 次仍无可用号码，本轮放弃。`,
                'warn'
              );
              await addLog(
                targetRun < totalRuns
                  ? `第 ${targetRun}/${totalRuns} 轮因接码号池暂无可用号码提前结束，自动流程将继续下一轮。`
                  : `第 ${targetRun}/${totalRuns} 轮因接码号池暂无可用号码提前结束，已无后续轮次，本次自动运行结束。`,
                'warn'
              );
              forceFreshTabsNextRun = true;
              break;
            }

            if (blockedByPlusNonFreeTrial) {
              roundSummary.status = 'failed';
              roundSummary.finalFailureReason = reason;
              await setState({
                autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              });
              await appendRoundRecordIfNeeded('failed', reason, err);
              cancelPendingCommands('当前轮因 Plus 免费试用资格不可用已终止。');
              await broadcastStopToContentScripts();
              if (!autoRunSkipFailures) {
                await addLog(
                  `第 ${targetRun}/${totalRuns} 轮检测到 Plus 今日应付金额非 0，自动重试未开启，当前自动运行将停止。`,
                  'warn'
                );
                stoppedEarly = true;
                await broadcastAutoRunStatus('stopped', {
                  currentRun: targetRun,
                  totalRuns,
                  attemptRun,
                  sessionId: 0,
                });
                break;
              }

              await addLog(`第 ${targetRun}/${totalRuns} 轮没有 Plus 免费试用资格，本轮将直接失败并跳过剩余重试。`, 'warn');
              await addLog(
                targetRun < totalRuns
                  ? `第 ${targetRun}/${totalRuns} 轮因 Plus 今日应付金额非 0 提前结束，自动流程将继续下一轮。`
                  : `第 ${targetRun}/${totalRuns} 轮因 Plus 今日应付金额非 0 提前结束，已无后续轮次，本次自动运行结束。`,
                'warn'
              );
              forceFreshTabsNextRun = true;
              break;
            }

            if (blockedByGpcTaskEnded) {
              roundSummary.status = 'failed';
              roundSummary.finalFailureReason = reason;
              await setState({
                autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              });
              await appendRoundRecordIfNeeded('failed', reason, err);
              cancelPendingCommands('当前轮因 GPC 任务已结束。');
              await broadcastStopToContentScripts();
              if (!autoRunSkipFailures) {
                await addLog(
                  `第 ${targetRun}/${totalRuns} 轮 GPC 任务已结束，自动重试未开启，当前自动运行将停止。`,
                  'warn'
                );
                stoppedEarly = true;
                await broadcastAutoRunStatus('stopped', {
                  currentRun: targetRun,
                  totalRuns,
                  attemptRun,
                  sessionId: 0,
                });
                break;
              }

              await addLog(`第 ${targetRun}/${totalRuns} 轮 GPC 任务已结束，本轮将直接失败并跳过剩余重试。`, 'warn');
              await addLog(
                targetRun < totalRuns
                  ? `第 ${targetRun}/${totalRuns} 轮因 GPC 任务结束提前结束，自动流程将继续下一轮。`
                  : `第 ${targetRun}/${totalRuns} 轮因 GPC 任务结束提前结束，已无后续轮次，本次自动运行结束。`,
                'warn'
              );
              forceFreshTabsNextRun = true;
              break;
            }

            if (blockedBySignupUserAlreadyExists) {
              roundSummary.status = 'failed';
              roundSummary.finalFailureReason = reason;
              await setState({
                autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              });
              await appendRoundRecordIfNeeded('failed', reason, err);
              cancelPendingCommands('当前轮因 user_already_exists 已终止。');
              await broadcastStopToContentScripts();
              if (!autoRunSkipFailures) {
                await addLog(
                  `第 ${targetRun}/${totalRuns} 轮触发 user_already_exists/用户已存在，自动重试未开启，当前自动运行将停止。`,
                  'warn'
                );
                stoppedEarly = true;
                await broadcastAutoRunStatus('stopped', {
                  currentRun: targetRun,
                  totalRuns,
                  attemptRun,
                  sessionId: 0,
                });
                break;
              }

              await addLog(`第 ${targetRun}/${totalRuns} 轮触发 user_already_exists/用户已存在，本轮将直接失败并跳过剩余重试。`, 'warn');
              await addLog(
                targetRun < totalRuns
                  ? `第 ${targetRun}/${totalRuns} 轮因 user_already_exists/用户已存在提前结束，自动流程将继续下一轮。`
                  : `第 ${targetRun}/${totalRuns} 轮因 user_already_exists/用户已存在提前结束，已无后续轮次，本次自动运行结束。`,
                'warn'
              );
              forceFreshTabsNextRun = true;
              break;
            }

            if (blockedByStep4Route405) {
              roundSummary.status = 'failed';
              roundSummary.finalFailureReason = reason;
              await setState({
                autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              });
              await appendRoundRecordIfNeeded('failed', reason, err);
              cancelPendingCommands('当前轮因步骤 4 连续 405 错误已终止。');
              await broadcastStopToContentScripts();
              if (!autoRunSkipFailures) {
                await addLog(
                  `第 ${targetRun}/${totalRuns} 轮步骤 4 连续 405 恢复失败，自动重试未开启，当前自动运行将停止。`,
                  'warn'
                );
                stoppedEarly = true;
                await broadcastAutoRunStatus('stopped', {
                  currentRun: targetRun,
                  totalRuns,
                  attemptRun,
                  sessionId: 0,
                });
                break;
              }

              await addLog(`第 ${targetRun}/${totalRuns} 轮步骤 4 连续 405 恢复失败，本轮将直接失败并跳过剩余重试。`, 'warn');
              await addLog(
                targetRun < totalRuns
                  ? `第 ${targetRun}/${totalRuns} 轮因步骤 4 连续 405 提前结束，自动流程将继续下一轮。`
                  : `第 ${targetRun}/${totalRuns} 轮因步骤 4 连续 405 提前结束，已无后续轮次，本次自动运行结束。`,
                'warn'
              );
              forceFreshTabsNextRun = true;
              break;
            }

            if (blockedByKiroProxy) {
              roundSummary.status = 'failed';
              roundSummary.finalFailureReason = reason;
              await setState({
                autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
              });
              await appendRoundRecordIfNeeded('failed', reason, err);
              cancelPendingCommands('当前轮检测到 Kiro 代理异常页，已停止自动运行，等待用户切换代理。');
              await broadcastStopToContentScripts();
              await addLog(`第 ${targetRun}/${totalRuns} 轮检测到 Kiro 代理异常页：${reason}`, 'error');
              await addLog('当前代理可能不可用，请先切换代理后再继续。自动运行已停止。', 'warn');
              stoppedEarly = true;
              await broadcastAutoRunStatus('stopped', {
                currentRun: targetRun,
                totalRuns,
                attemptRun,
                sessionId: 0,
              });
              break;
            }

            if (canRetry) {
              const retryIndex = attemptRun;
              if (isRestartCurrentAttemptError(err)) {
                await addLog(`第 ${targetRun}/${totalRuns} 轮第 ${attemptRun} 次尝试需要整轮重开：${reason}`, 'warn');
              } else {
                await addLog(`第 ${targetRun}/${totalRuns} 轮第 ${attemptRun} 次尝试失败：${reason}`, 'error');
              }
              cancelPendingCommands('当前尝试已放弃。');
              await broadcastStopToContentScripts();
              await broadcastAutoRunStatus('retrying', {
                currentRun: targetRun,
                totalRuns,
                attemptRun,
                sessionId,
              });
              forceFreshTabsNextRun = true;
              await addLog(
                keepSameEmailUntilAddPhone
                  ? `自动重试：${Math.round(AUTO_RUN_RETRY_DELAY_MS / 1000)} 秒后继续使用当前邮箱，开始第 ${targetRun}/${totalRuns} 轮第 ${attemptRun + 1} 次尝试。`
                  : `自动重试：${Math.round(AUTO_RUN_RETRY_DELAY_MS / 1000)} 秒后开始第 ${targetRun}/${totalRuns} 轮第 ${attemptRun + 1} 次尝试（第 ${retryIndex}/${AUTO_RUN_MAX_RETRIES_PER_ROUND} 次重试）。`,
                'warn'
              );
              try {
                await sleepWithStop(AUTO_RUN_RETRY_DELAY_MS);
              } catch (sleepError) {
                if (isStopError(sleepError)) {
                  stoppedEarly = true;
                  await appendRoundRecordIfNeeded('stopped', getErrorMessage(sleepError), sleepError);
                  await addLog(`第 ${targetRun}/${totalRuns} 轮已被用户停止`, 'warn');
                  await broadcastAutoRunStatus('stopped', {
                    currentRun: targetRun,
                    totalRuns,
                    attemptRun,
                    sessionId: 0,
                  });
                  break;
                }
                throw sleepError;
              }
              try {
                const parkedForRetry = await waitBeforeAutoRunRetry(targetRun, totalRuns, attemptRun + 1, {
                  autoRunSkipFailures,
                  roundSummaries,
                });
                if (parkedForRetry) {
                  parkedByTimer = true;
                  break;
                }
              } catch (sleepError) {
                if (isStopError(sleepError)) {
                  stoppedEarly = true;
                  await appendRoundRecordIfNeeded('stopped', getErrorMessage(sleepError), sleepError);
                  await addLog(`第 ${targetRun}/${totalRuns} 轮已被用户停止`, 'warn');
                  await broadcastAutoRunStatus('stopped', {
                    currentRun: targetRun,
                    totalRuns,
                    attemptRun,
                    sessionId: 0,
                  });
                  break;
                }
                throw sleepError;
              }
              attemptRun += 1;
              reuseExistingProgress = false;
              continue;
            }

            roundSummary.status = 'failed';
            roundSummary.finalFailureReason = reason;
            await setState({
              autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
            });
            await appendRoundRecordIfNeeded('failed', reason, err);
            // 例外：页面/会话临时问题（停留在已登录首页 / 内容脚本断连）即使没开自动重试，
            // 也只跳过当前轮、继续下一轮，不终止整段。
            const skippableEntryFailure = isRoundSkippableEntryFailure(reason);
            if (!autoRunSkipFailures && !skippableEntryFailure) {
              cancelPendingCommands('当前轮执行失败。');
              await broadcastStopToContentScripts();
              await addLog('自动重试未开启，自动运行将在当前失败后停止。', 'warn');
              stoppedEarly = true;
              await broadcastAutoRunStatus('stopped', {
                currentRun: targetRun,
                totalRuns,
                attemptRun,
                sessionId: 0,
              });
              break;
            }
            if (skippableEntryFailure && !autoRunSkipFailures) {
              await addLog(
                targetRun < totalRuns
                  ? `第 ${targetRun}/${totalRuns} 轮遇到页面/会话临时问题，自动跳过当前轮继续下一轮（下一轮会清理会话重开）：${reason}`
                  : `第 ${targetRun}/${totalRuns} 轮遇到页面/会话临时问题，已无后续轮次，本次自动运行结束：${reason}`,
                'warn'
              );
            } else {
              await addLog(`第 ${targetRun}/${totalRuns} 轮最终失败：${reason}`, 'error');
              await addLog(
                targetRun < totalRuns
                  ? `第 ${targetRun}/${totalRuns} 轮已达到 ${AUTO_RUN_MAX_RETRIES_PER_ROUND} 次重试上限，继续下一轮。`
                  : `第 ${targetRun}/${totalRuns} 轮已达到 ${AUTO_RUN_MAX_RETRIES_PER_ROUND} 次重试上限，本次自动运行结束。`,
                'warn'
              );
            }
            cancelPendingCommands('当前轮结束，准备下一轮。');
            await broadcastStopToContentScripts();
            forceFreshTabsNextRun = true;
            break;
          } finally {
            reuseExistingProgress = false;
            continueCurrentOnFirstAttempt = false;
          }
        }

        if (stoppedEarly || parkedByTimer) {
          break;
        }

        try {
          const parkedForNextRound = await waitBetweenAutoRunRounds(targetRun, totalRuns, roundSummary, {
            autoRunSkipFailures,
            roundSummaries,
          });
          if (parkedForNextRound) {
            parkedByTimer = true;
            break;
          }
        } catch (sleepError) {
          if (isStopError(sleepError)) {
            stoppedEarly = true;
            await addLog(`第 ${targetRun}/${totalRuns} 轮已被用户停止`, 'warn');
            await broadcastAutoRunStatus('stopped', {
              currentRun: targetRun,
              totalRuns,
              attemptRun: runtime.get().autoRunAttemptRun,
              sessionId: 0,
            });
            break;
          }
          throw sleepError;
        }
      }

      if (parkedByTimer) {
        runtime.set({ autoRunActive: false });
        clearStopRequest();
        return;
      }

      await setState({
        autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
      });
      await logAutoRunFinalSummary(totalRuns, roundSummaries);

      const finalRuntime = runtime.get();
      if (deps.getStopRequested() || stoppedEarly) {
        await addLog(`=== 已停止，完成 ${successfulRuns}/${finalRuntime.autoRunTotalRuns} 轮 ===`, 'warn');
        await broadcastAutoRunStatus('stopped', {
          currentRun: finalRuntime.autoRunCurrentRun,
          totalRuns: finalRuntime.autoRunTotalRuns,
          attemptRun: finalRuntime.autoRunAttemptRun,
          sessionId: 0,
        });
      } else {
        await addLog(`=== 全部 ${finalRuntime.autoRunTotalRuns} 轮已执行完成，成功 ${successfulRuns} 轮 ===`, 'ok');
        await broadcastAutoRunStatus('complete', {
          currentRun: finalRuntime.autoRunTotalRuns,
          totalRuns: finalRuntime.autoRunTotalRuns,
          attemptRun: finalRuntime.autoRunAttemptRun,
          sessionId: 0,
        });
      }
      runtime.set({ autoRunActive: false, autoRunSessionId: 0 });
      const afterRuntime = runtime.get();
      await setState({
        autoRunSessionId: 0,
        autoRunRoundSummaries: serializeAutoRunRoundSummaries(totalRuns, roundSummaries),
        autoRunTimerPlan: null,
        scheduledAutoRunPlan: null,
        ...getAutoRunStatusPayload(deps.getStopRequested() || stoppedEarly ? 'stopped' : 'complete', {
          currentRun: deps.getStopRequested() || stoppedEarly ? afterRuntime.autoRunCurrentRun : afterRuntime.autoRunTotalRuns,
          totalRuns: afterRuntime.autoRunTotalRuns,
          attemptRun: afterRuntime.autoRunAttemptRun,
          sessionId: 0,
        }),
      });
      clearStopRequest();
    }

    return {
      autoRunLoop,
      buildAutoRunRoundSummaries,
      createAutoRunRoundSummary,
      formatAutoRunFailureReasons,
      getAutoRunRoundRetryCount,
      handleAutoRunLoopUnhandledError,
      logAutoRunFinalSummary,
      normalizeAutoRunRoundSummary,
      resolveAutoRunAccountRecordStatus,
      serializeAutoRunRoundSummaries,
      skipAutoRunCountdown,
      startAutoRunLoop,
      waitBetweenAutoRunRounds,
      waitBeforeAutoRunRetry,
    };
  }

  return {
    createAutoRunController,
    isRoundSkippableEntryFailure,
  };
});

/* eslint-disable rulesdir/prefer-underscore-method */
import Onyx from 'react-native-onyx';
import _ from 'underscore';
import lodashGet from 'lodash/get';
import Str from 'expensify-common/lib/str';
import ONYXKEYS from '../ONYXKEYS';
import * as ReportUtils from './ReportUtils';
import * as ReportActionsUtils from './ReportActionsUtils';
import * as Localize from './Localize';
import CONST from '../CONST';
import * as OptionsListUtils from './OptionsListUtils';
import * as CollectionUtils from './CollectionUtils';
import * as LocalePhoneNumber from './LocalePhoneNumber';
import * as UserUtils from './UserUtils';
import * as PersonalDetailsUtils from './PersonalDetailsUtils';

const visibleReportActionItems = {};
const lastReportActions = {};
Onyx.connect({
    key: ONYXKEYS.COLLECTION.REPORT_ACTIONS,
    callback: (actions, key) => {
        if (!key || !actions) {
            return;
        }
        const reportID = CollectionUtils.extractCollectionItemID(key);

        const actionsArray = ReportActionsUtils.getSortedReportActions(_.toArray(actions));
        lastReportActions[reportID] = _.last(actionsArray);

        // The report is only visible if it is the last action not deleted that
        // does not match a closed or created state.
        const reportActionsForDisplay = _.filter(
            actionsArray,
            (reportAction, actionKey) =>
                ReportActionsUtils.shouldReportActionBeVisible(reportAction, actionKey) &&
                reportAction.actionName !== CONST.REPORT.ACTIONS.TYPE.CREATED &&
                reportAction.pendingAction !== CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE,
        );
        visibleReportActionItems[reportID] = _.last(reportActionsForDisplay);
    },
});

// Session can remain stale because the only way for the current user to change is to
// sign out and sign in, which would clear out all the Onyx
// data anyway and cause SidebarLinks to rerender.
let currentUserAccountID;
Onyx.connect({
    key: ONYXKEYS.SESSION,
    callback: (val) => {
        if (!val) {
            return;
        }

        currentUserAccountID = val.accountID;
    },
});

let allPersonalDetails;
Onyx.connect({
    key: ONYXKEYS.PERSONAL_DETAILS_LIST,
    callback: (val) => (allPersonalDetails = val),
});

let resolveSidebarIsReadyPromise;

let sidebarIsReadyPromise = new Promise((resolve) => {
    resolveSidebarIsReadyPromise = resolve;
});

function resetIsSidebarLoadedReadyPromise() {
    sidebarIsReadyPromise = new Promise((resolve) => {
        resolveSidebarIsReadyPromise = resolve;
    });
}

function isSidebarLoadedReady() {
    return sidebarIsReadyPromise;
}

function compareStringDates(stringA, stringB) {
    if (stringA < stringB) {
        return -1;
    }
    if (stringA > stringB) {
        return 1;
    }
    return 0;
}

function setIsSidebarLoadedReady() {
    resolveSidebarIsReadyPromise();
}

// Define a cache object to store the memoized results
const reportIDsCache = new Map();

// Function to set a key-value pair while maintaining the maximum key limit
function setWithLimit(map, key, value) {
    if (map.size >= 5) {
        // If the map has reached its limit, remove the first (oldest) key-value pair
        const firstKey = map.keys().next().value;
        map.delete(firstKey);
    }
    map.set(key, value);
}

// Variable to verify if ONYX actions are loaded
let hasInitialReportActions = false;

/**
 * @param {String} currentReportId
 * @param {Object} allReportsDict
 * @param {Object} betas
 * @param {String[]} policies
 * @param {String} priorityMode
 * @param {Object} allReportActions
 * @returns {String[]} An array of reportIDs sorted in the proper order
 */
function getOrderedReportIDs(currentReportId, allReportsDict, betas, policies, priorityMode, allReportActions) {
    // Generate a unique cache key based on the function arguments
    const cachedReportsKey = JSON.stringify(
        // eslint-disable-next-line es/no-optional-chaining
        [currentReportId, allReportsDict, betas, policies, priorityMode, allReportActions[`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${currentReportId}`]?.length || 1],
        (key, value) => {
            /**
             *  Exclude 'participantAccountIDs', 'participants' and 'lastMessageText' not to overwhelm a cached key value with huge data,
             *  which we don't need to store in a cacheKey
             */
            if (key === 'participantAccountIDs' || key === 'participants' || key === 'lastMessageText') {
                return undefined;
            }
            return value;
        },
    );

    // Check if the result is already in the cache
    if (reportIDsCache.has(cachedReportsKey) && hasInitialReportActions) {
        return reportIDsCache.get(cachedReportsKey);
    }

    // This is needed to prevent caching when Onyx is empty for a second render
    hasInitialReportActions = Object.values(lastReportActions).length > 0;

    const isInGSDMode = priorityMode === CONST.PRIORITY_MODE.GSD;
    const isInDefaultMode = !isInGSDMode;
    const allReportsDictValues = Object.values(allReportsDict);
    // Filter out all the reports that shouldn't be displayed
    const reportsToDisplay = allReportsDictValues.filter((report) => ReportUtils.shouldReportBeInOptionList(report, currentReportId, isInGSDMode, betas, policies, allReportActions, true));

    if (reportsToDisplay.length === 0) {
        // Display Concierge chat report when there is no report to be displayed
        const conciergeChatReport = allReportsDictValues.find(ReportUtils.isConciergeChatReport);
        if (conciergeChatReport) {
            reportsToDisplay.push(conciergeChatReport);
        }
    }

    // There are a few properties that need to be calculated for the report which are used when sorting reports.
    reportsToDisplay.forEach((report) => {
        // Normally, the spread operator would be used here to clone the report and prevent the need to reassign the params.
        // However, this code needs to be very performant to handle thousands of reports, so in the interest of speed, we're just going to disable this lint rule and add
        // the reportDisplayName property to the report object directly.
        // eslint-disable-next-line no-param-reassign
        report.displayName = ReportUtils.getReportName(report);

        // eslint-disable-next-line no-param-reassign
        report.iouReportAmount = ReportUtils.getMoneyRequestReimbursableTotal(report, allReportsDict);
    });

    // The LHN is split into five distinct groups, and each group is sorted a little differently. The groups will ALWAYS be in this order:
    // 1. Pinned - Always sorted by reportDisplayName
    // 2. Outstanding IOUs - Always sorted by iouReportAmount with the largest amounts at the top of the group
    // 3. Drafts - Always sorted by reportDisplayName
    // 4. Non-archived reports and settled IOUs
    //      - Sorted by lastVisibleActionCreated in default (most recent) view mode
    //      - Sorted by reportDisplayName in GSD (focus) view mode
    // 5. Archived reports
    //      - Sorted by lastVisibleActionCreated in default (most recent) view mode
    //      - Sorted by reportDisplayName in GSD (focus) view mode
    const pinnedReports = [];
    const outstandingIOUReports = [];
    const draftReports = [];
    const nonArchivedReports = [];
    const archivedReports = [];
    reportsToDisplay.forEach((report) => {
        if (report.isPinned) {
            pinnedReports.push(report);
        } else if (ReportUtils.isWaitingForIOUActionFromCurrentUser(report)) {
            outstandingIOUReports.push(report);
        } else if (report.hasDraft) {
            draftReports.push(report);
        } else if (ReportUtils.isArchivedRoom(report)) {
            archivedReports.push(report);
        } else {
            nonArchivedReports.push(report);
        }
    });

    // Sort each group of reports accordingly
    pinnedReports.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
    outstandingIOUReports.sort((a, b) => b.iouReportAmount - a.iouReportAmount || a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
    draftReports.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

    if (isInDefaultMode) {
        nonArchivedReports.sort(
            (a, b) => compareStringDates(b.lastVisibleActionCreated, a.lastVisibleActionCreated) || a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()),
        );
        // For archived reports ensure that most recent reports are at the top by reversing the order
        archivedReports.sort((a, b) => compareStringDates(b.lastVisibleActionCreated, a.lastVisibleActionCreated));
    } else {
        nonArchivedReports.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
        archivedReports.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
    }

    // Now that we have all the reports grouped and sorted, they must be flattened into an array and only return the reportID.
    // The order the arrays are concatenated in matters and will determine the order that the groups are displayed in the sidebar.
    const LHNReports = [].concat(pinnedReports, outstandingIOUReports, draftReports, nonArchivedReports, archivedReports).map((report) => report.reportID);
    setWithLimit(reportIDsCache, cachedReportsKey, LHNReports);
    return LHNReports;
}

/**
 * Gets all the data necessary for rendering an OptionRowLHN component
 *
 * @param {Object} report
 * @param {Object} reportActions
 * @param {String} preferredLocale
 * @param {Object} [policy]
 * @param {Object} parentReportAction
 * @returns {Object}
 */
function getOptionData(report, reportActions, preferredLocale, policy, parentReportAction) {
    // When a user signs out, Onyx is cleared. Due to the lazy rendering with a virtual list, it's possible for
    // this method to be called after the Onyx data has been cleared out. In that case, it's fine to do
    // a null check here and return early.
    const personalDetails = allPersonalDetails;
    if (!report || !personalDetails) {
        return;
    }
    const result = {
        text: null,
        alternateText: null,
        pendingAction: null,
        allReportErrors: null,
        brickRoadIndicator: null,
        icons: null,
        tooltipText: null,
        ownerAccountID: null,
        subtitle: null,
        participantsList: null,
        login: null,
        accountID: null,
        managerID: null,
        reportID: null,
        policyID: null,
        statusNum: null,
        stateNum: null,
        phoneNumber: null,
        isUnread: null,
        isUnreadWithMention: null,
        hasDraftComment: false,
        keyForList: null,
        searchText: null,
        isPinned: false,
        hasOutstandingIOU: false,
        iouReportID: null,
        isIOUReportOwner: null,
        iouReportAmount: 0,
        isChatRoom: false,
        isArchivedRoom: false,
        shouldShowSubscript: false,
        isPolicyExpenseChat: false,
        isMoneyRequestReport: false,
        isExpenseRequest: false,
        isWaitingOnBankAccount: false,
        isAllowedToComment: true,
        chatType: null,
    };

    const participantPersonalDetailList = _.values(OptionsListUtils.getPersonalDetailsForAccountIDs(report.participantAccountIDs, personalDetails));
    const personalDetail = participantPersonalDetailList[0] || {};

    result.isThread = ReportUtils.isChatThread(report);
    result.isChatRoom = ReportUtils.isChatRoom(report);
    result.isTaskReport = ReportUtils.isTaskReport(report);
    if (result.isTaskReport) {
        result.isWaitingForTaskCompleteFromAssignee = ReportUtils.isWaitingForTaskCompleteFromAssignee(report, parentReportAction);
    }
    result.isArchivedRoom = ReportUtils.isArchivedRoom(report);
    result.isPolicyExpenseChat = ReportUtils.isPolicyExpenseChat(report);
    result.isExpenseRequest = ReportUtils.isExpenseRequest(report);
    result.isMoneyRequestReport = ReportUtils.isMoneyRequestReport(report);
    result.shouldShowSubscript = ReportUtils.shouldReportShowSubscript(report);
    result.pendingAction = report.pendingFields ? report.pendingFields.addWorkspaceRoom || report.pendingFields.createChat : null;
    result.allReportErrors = OptionsListUtils.getAllReportErrors(report, reportActions);
    result.brickRoadIndicator = !_.isEmpty(result.allReportErrors) ? CONST.BRICK_ROAD_INDICATOR_STATUS.ERROR : '';
    result.ownerAccountID = report.ownerAccountID;
    result.managerID = report.managerID;
    result.reportID = report.reportID;
    result.policyID = report.policyID;
    result.stateNum = report.stateNum;
    result.statusNum = report.statusNum;
    result.isUnread = ReportUtils.isUnread(report);
    result.isUnreadWithMention = ReportUtils.isUnreadWithMention(report);
    result.hasDraftComment = report.hasDraft;
    result.isPinned = report.isPinned;
    result.iouReportID = report.iouReportID;
    result.keyForList = String(report.reportID);
    result.tooltipText = ReportUtils.getReportParticipantsTitle(report.participantAccountIDs || []);
    result.hasOutstandingIOU = report.hasOutstandingIOU;
    result.parentReportID = report.parentReportID || null;
    result.isWaitingOnBankAccount = report.isWaitingOnBankAccount;
    result.notificationPreference = report.notificationPreference || null;
    result.isAllowedToComment = !ReportUtils.shouldDisableWriteActions(report);
    result.chatType = report.chatType;

    const hasMultipleParticipants = participantPersonalDetailList.length > 1 || result.isChatRoom || result.isPolicyExpenseChat;
    const subtitle = ReportUtils.getChatRoomSubtitle(report);

    const login = Str.removeSMSDomain(lodashGet(personalDetail, 'login', ''));
    const status = lodashGet(personalDetail, 'status', '');
    const formattedLogin = Str.isSMSLogin(login) ? LocalePhoneNumber.formatPhoneNumber(login) : login;

    // We only create tooltips for the first 10 users or so since some reports have hundreds of users, causing performance to degrade.
    const displayNamesWithTooltips = ReportUtils.getDisplayNamesWithTooltips((participantPersonalDetailList || []).slice(0, 10), hasMultipleParticipants);
    const lastMessageTextFromReport = OptionsListUtils.getLastMessageTextForReport(report);

    // If the last actor's details are not currently saved in Onyx Collection,
    // then try to get that from the last report action if that action is valid
    // to get data from.
    let lastActorDetails = personalDetails[report.lastActorAccountID] || null;
    if (!lastActorDetails && visibleReportActionItems[report.reportID]) {
        const lastActorDisplayName = lodashGet(visibleReportActionItems[report.reportID], 'person[0].text');
        lastActorDetails = lastActorDisplayName
            ? {
                  displayName: lastActorDisplayName,
                  accountID: report.lastActorAccountID,
              }
            : null;
    }
    const lastActorDisplayName =
        hasMultipleParticipants && lastActorDetails && lastActorDetails.accountID && Number(lastActorDetails.accountID) !== currentUserAccountID ? lastActorDetails.displayName : '';
    let lastMessageText = lastMessageTextFromReport;

    if (result.isArchivedRoom) {
        const archiveReason =
            (lastReportActions[report.reportID] && lastReportActions[report.reportID].originalMessage && lastReportActions[report.reportID].originalMessage.reason) ||
            CONST.REPORT.ARCHIVE_REASON.DEFAULT;
        lastMessageText = Localize.translate(preferredLocale, `reportArchiveReasons.${archiveReason}`, {
            displayName: archiveReason.displayName || PersonalDetailsUtils.getDisplayNameOrDefault(lastActorDetails, 'displayName'),
            policyName: ReportUtils.getPolicyName(report, false, policy),
        });
    }

    if ((result.isChatRoom || result.isPolicyExpenseChat || result.isThread || result.isTaskReport) && !result.isArchivedRoom) {
        const lastAction = visibleReportActionItems[report.reportID];
        if (lastAction && lastAction.actionName === CONST.REPORT.ACTIONS.TYPE.RENAMED) {
            const newName = lodashGet(lastAction, 'originalMessage.newName', '');
            result.alternateText = Localize.translate(preferredLocale, 'newRoomPage.roomRenamedTo', {newName});
        } else if (lastAction && lastAction.actionName === CONST.REPORT.ACTIONS.TYPE.TASKREOPENED) {
            result.alternateText = `${Localize.translate(preferredLocale, 'task.messages.reopened')}`;
        } else if (lastAction && lastAction.actionName === CONST.REPORT.ACTIONS.TYPE.TASKCOMPLETED) {
            result.alternateText = `${Localize.translate(preferredLocale, 'task.messages.completed')}`;
        } else if (
            lastAction &&
            _.includes(
                [
                    CONST.REPORT.ACTIONS.TYPE.ROOMCHANGELOG.INVITE_TO_ROOM,
                    CONST.REPORT.ACTIONS.TYPE.ROOMCHANGELOG.REMOVE_FROM_ROOM,
                    CONST.REPORT.ACTIONS.TYPE.POLICYCHANGELOG.INVITE_TO_ROOM,
                    CONST.REPORT.ACTIONS.TYPE.POLICYCHANGELOG.REMOVE_FROM_ROOM,
                ],
                lastAction.actionName,
            )
        ) {
            const targetAccountIDs = lodashGet(lastAction, 'originalMessage.targetAccountIDs', []);
            const verb =
                lastAction.actionName === CONST.REPORT.ACTIONS.TYPE.ROOMCHANGELOG.INVITE_TO_ROOM || lastAction.actionName === CONST.REPORT.ACTIONS.TYPE.POLICYCHANGELOG.INVITE_TO_ROOM
                    ? 'invited'
                    : 'removed';
            const users = targetAccountIDs.length > 1 ? 'users' : 'user';
            result.alternateText = `${verb} ${targetAccountIDs.length} ${users}`;

            const roomName = lodashGet(lastAction, 'originalMessage.roomName', '');
            if (roomName) {
                const preposition =
                    lastAction.actionName === CONST.REPORT.ACTIONS.TYPE.ROOMCHANGELOG.INVITE_TO_ROOM || lastAction.actionName === CONST.REPORT.ACTIONS.TYPE.POLICYCHANGELOG.INVITE_TO_ROOM
                        ? ' to'
                        : ' from';
                result.alternateText += `${preposition} ${roomName}`;
            }
        } else if (lastAction && lastAction.actionName !== CONST.REPORT.ACTIONS.TYPE.REPORTPREVIEW && lastActorDisplayName && lastMessageTextFromReport) {
            result.alternateText = `${lastActorDisplayName}: ${lastMessageText}`;
        } else {
            result.alternateText = lastAction && lastMessageTextFromReport.length > 0 ? lastMessageText : Localize.translate(preferredLocale, 'report.noActivityYet');
        }
    } else {
        if (!lastMessageText) {
            // Here we get the beginning of chat history message and append the display name for each user, adding pronouns if there are any.
            // We also add a fullstop after the final name, the word "and" before the final name and commas between all previous names.
            lastMessageText =
                Localize.translate(preferredLocale, 'reportActionsView.beginningOfChatHistory') +
                _.map(displayNamesWithTooltips, ({displayName, pronouns}, index) => {
                    const formattedText = _.isEmpty(pronouns) ? displayName : `${displayName} (${pronouns})`;

                    if (index === displayNamesWithTooltips.length - 1) {
                        return `${formattedText}.`;
                    }
                    if (index === displayNamesWithTooltips.length - 2) {
                        return `${formattedText} ${Localize.translate(preferredLocale, 'common.and')}`;
                    }
                    if (index < displayNamesWithTooltips.length - 2) {
                        return `${formattedText},`;
                    }
                }).join(' ');
        }

        result.alternateText = lastMessageText || formattedLogin;
    }

    result.isIOUReportOwner = ReportUtils.isIOUOwnedByCurrentUser(result);
    result.iouReportAmount = ReportUtils.getMoneyRequestReimbursableTotal(result);

    if (!hasMultipleParticipants) {
        result.accountID = personalDetail.accountID;
        result.login = personalDetail.login;
        result.phoneNumber = personalDetail.phoneNumber;
    }

    const reportName = ReportUtils.getReportName(report, policy);

    result.text = reportName;
    result.subtitle = subtitle;
    result.participantsList = participantPersonalDetailList;

    result.icons = ReportUtils.getIcons(report, personalDetails, UserUtils.getAvatar(personalDetail.avatar, personalDetail.accountID), '', -1, policy);
    result.searchText = OptionsListUtils.getSearchText(report, reportName, participantPersonalDetailList, result.isChatRoom || result.isPolicyExpenseChat, result.isThread);
    result.displayNamesWithTooltips = displayNamesWithTooltips;

    if (status) {
        result.status = status;
    }
    result.type = report.type;

    return result;
}

export default {
    getOptionData,
    getOrderedReportIDs,
    setIsSidebarLoadedReady,
    isSidebarLoadedReady,
    resetIsSidebarLoadedReadyPromise,
};

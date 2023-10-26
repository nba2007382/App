import {withOnyx} from 'react-native-onyx';
import lodashGet from 'lodash/get';
import _ from 'underscore';
import PropTypes from 'prop-types';
import React, {useEffect, useRef, useMemo} from 'react';
import {deepEqual} from 'fast-equals';
import SidebarUtils from '../../libs/SidebarUtils';
import compose from '../../libs/compose';
import ONYXKEYS from '../../ONYXKEYS';
import OptionRowLHN, {propTypes as basePropTypes, defaultProps as baseDefaultProps} from './OptionRowLHN';
import * as Report from '../../libs/actions/Report';
import * as ReportActionsUtils from '../../libs/ReportActionsUtils';
import * as TransactionUtils from '../../libs/TransactionUtils';

import CONST from '../../CONST';
import reportActionPropTypes from '../../pages/home/report/reportActionPropTypes';

const propTypes = {
    /** Whether row should be focused */
    isFocused: PropTypes.bool,

    /** The preferred language for the app */
    preferredLocale: PropTypes.string,

    /** The full data of the report */
    // eslint-disable-next-line react/forbid-prop-types
    fullReport: PropTypes.object,

    /** The policy which the user has access to and which the report could be tied to */
    policy: PropTypes.shape({
        /** The ID of the policy */
        id: PropTypes.string,
        /** Name of the policy */
        name: PropTypes.string,
        /** Avatar of the policy */
        avatar: PropTypes.string,
    }),

    /** The actions from the parent report */
    parentReportActions: PropTypes.objectOf(PropTypes.shape(reportActionPropTypes)),

    /** The transaction from the parent report action */
    transaction: PropTypes.shape({
        /** The ID of the transaction */
        transactionID: PropTypes.string,
    }),
    ...basePropTypes,
};

const defaultProps = {
    isFocused: false,
    fullReport: {},
    policy: {},
    parentReportActions: {},
    transaction: {},
    preferredLocale: CONST.LOCALES.DEFAULT,
    ...baseDefaultProps,
};

/*
 * This component gets the data from onyx for the actual
 * OptionRowLHN component.
 * The OptionRowLHN component is memoized, so it will only
 * re-render if the data really changed.
 */
function OptionRowLHNData({
    isFocused,
    fullReport,
    reportActions,
    preferredLocale,
    comment,
    policy,
    receiptTransactions,
    parentReportActions,
    transaction,
    ...propsToForward
}) {
    const reportID = propsToForward.reportID;

    const parentReportAction = parentReportActions[fullReport.parentReportActionID];

    const optionItemRef = useRef();

    const linkedTransaction = useMemo(() => {
        const sortedReportActions = ReportActionsUtils.getSortedReportActionsForDisplay(reportActions);
        const lastReportAction = _.first(sortedReportActions);
        return TransactionUtils.getLinkedTransaction(lastReportAction);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fullReport.reportID, receiptTransactions, reportActions]);

    const optionItem = useMemo(() => {
        // Note: ideally we'd have this as a dependent selector in onyx!
        const item = SidebarUtils.getOptionData(fullReport, reportActions, preferredLocale, policy, parentReportAction);
        if (deepEqual(item, optionItemRef.current)) {
            return optionItemRef.current;
        }
        optionItemRef.current = item;
        return item;
        // Listen parentReportAction to update title of thread report when parentReportAction changed
        // Listen to transaction to update title of transaction report when transaction changed
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fullReport, linkedTransaction, reportActions, preferredLocale, policy, parentReportAction, transaction]);

    useEffect(() => {
        if (!optionItem || optionItem.hasDraftComment || !comment || comment.length <= 0 || isFocused) {
            return;
        }
        Report.setReportWithDraft(reportID, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <OptionRowLHN
            // eslint-disable-next-line react/jsx-props-no-spreading
            {...propsToForward}
            isFocused={isFocused}
            optionItem={optionItem}
        />
    );
}

OptionRowLHNData.propTypes = propTypes;
OptionRowLHNData.defaultProps = defaultProps;
OptionRowLHNData.displayName = 'OptionRowLHNData';

/**
 * This component is rendered in a list.
 * On scroll we want to avoid that a item re-renders
 * just because the list has to re-render when adding more items.
 * Thats also why the React.memo is used on the outer component here, as we just
 * use it to prevent re-renders from parent re-renders.
 */
export default React.memo(
    compose(
        withOnyx({
            comment: {
                key: ({reportID}) => `${ONYXKEYS.COLLECTION.REPORT_DRAFT_COMMENT}${reportID}`,
            },
            fullReport: {
                key: ({reportID}) => `${ONYXKEYS.COLLECTION.REPORT}${reportID}`,
            },
            reportActions: {
                key: ({reportID}) => `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`,
                canEvict: false,
            },
            preferredLocale: {
                key: ONYXKEYS.NVP_PREFERRED_LOCALE,
            },
        }),
        // eslint-disable-next-line rulesdir/no-multiple-onyx-in-file
        withOnyx({
            parentReportActions: {
                key: ({fullReport}) => `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${fullReport.parentReportID}`,
                canEvict: false,
            },
            policy: {
                key: ({fullReport}) => `${ONYXKEYS.COLLECTION.POLICY}${fullReport.policyID}`,
            },
            // Ideally, we aim to access only the last transaction for the current report by listening to changes in reportActions.
            // In some scenarios, a transaction might be created after reportActions have been modified.
            // This can lead to situations where `lastTransaction` doesn't update and retains the previous value.
            // However, performance overhead of this is minimized by using memos inside the component.
            receiptTransactions: {key: ONYXKEYS.COLLECTION.TRANSACTION},
        }),
        // eslint-disable-next-line rulesdir/no-multiple-onyx-in-file
        withOnyx({
            transaction: {
                key: ({fullReport, parentReportActions}) =>
                    `${ONYXKEYS.COLLECTION.TRANSACTION}${lodashGet(parentReportActions, [fullReport.parentReportActionID, 'originalMessage', 'IOUTransactionID'], '')}`,
            },
        }),
    )(OptionRowLHNData),
);

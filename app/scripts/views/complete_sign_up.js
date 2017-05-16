/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Complete sign up is used to complete the email verification for one
 * of three types of users:
 *
 * 1. New users that just signed up.
 * 2. Existing users that have signed in with an unverified account.
 * 3. Existing users that are signing into Sync and
 *    must re-confirm their account.
 * 4. Existing users that confirmed a secondary email.
 *
 * The auth server endpoints that are called are the same in all cases.
 */

define(function (require, exports, module) {
  'use strict';

  const AuthErrors = require('lib/auth-errors');
  const BaseView = require('views/base');
  const Cocktail = require('cocktail');
  const CompleteSignUpTemplate = require('stache!templates/complete_sign_up');
  const ConnectAnotherDeviceMixin = require('views/mixins/connect-another-device-mixin');
  const ExperimentMixin = require('views/mixins/experiment-mixin');
  const MarketingEmailErrors = require('lib/marketing-email-errors');
  const ResendMixin = require('views/mixins/resend-mixin')();
  const ResumeTokenMixin = require('views/mixins/resume-token-mixin');
  const UserAgentMixin = require('lib/user-agent-mixin');
  const VerificationInfo = require('models/verification/sign-up');
  const VerificationReasonMixin = require('views/mixins/verification-reason-mixin');

  const CompleteSignUpView = BaseView.extend({
    template: CompleteSignUpTemplate,
    className: 'complete_sign_up',

    initialize (options = {}) {
      this._verificationInfo = new VerificationInfo(this.getSearchParams());
      const uid = this._verificationInfo.get('uid');

      const account = options.account || this.user.getAccountByUid(uid);
      // the account will not exist if verifying in a second browser, and the
      // default account will be returned. Add the uid to the account so
      // verification can still occur.
      if (account.isDefault()) {
        account.set('uid', uid);
      }

      this._account = account;

      // cache the email in case we need to attempt to resend the
      // verification link
      this._email = this._account.get('email');
    },

    getAccount () {
      return this._account;
    },

    beforeRender () {
      const verificationInfo = this._verificationInfo;
      if (! verificationInfo.isValid()) {
        // One or more parameters fails validation. Abort and show an
        // error message before doing any more checks.
        this.logError(AuthErrors.toError('DAMAGED_VERIFICATION_LINK'));
        return true;
      }

      const account = this.getAccount();
      // Loads the email from the resume token to smooth out the signin
      // flow if the user verifies in a 2nd Firefox.
      account.populateFromStringifiedResumeToken(this.getSearchParam('resume'));

      const code = verificationInfo.get('code');
      const options = {
        reminder: verificationInfo.get('reminder'),
        secondaryEmailVerified: this.getSearchParam('secondary_email_verified') || null,
        serverVerificationStatus: this.getSearchParam('server_verification') || null,
        service: this.relier.get('service') || null,
        type: verificationInfo.get('type')
      };

      return this.user.completeAccountSignUp(account, code, options)
        .fail((err) => this._logAndAbsorbMarketingClientErrors(err))
        .then(() => this._notifyBrokerAndComplete(account))
        .fail((err) => this._handleVerificationErrors(err));
    },

    context () {
      const verificationInfo = this._verificationInfo;
      return {
        canResend: this._canResend(),
        error: this.model.get('error'),
        // If the link is invalid, print a special error message.
        isLinkDamaged: ! verificationInfo.isValid(),
        isLinkExpired: verificationInfo.isExpired(),
        isLinkUsed: verificationInfo.isUsed()
      };
    },

    /**
     * Log and swallow any errors that are generated from attempting to
     * sign up the user to marketing email.
     *
     * @param {Error} err
     * @private
     */
    _logAndAbsorbMarketingClientErrors (err) {
      if (MarketingEmailErrors.created(err)) {
        // A basket error should not prevent the
        // sign up verification from completing, nor
        // should an error be displayed to the user.
        // Log the error and nothing else.
        this.logError(err);
      } else {
        throw err;
      }
    },

    /**
     * Notify the broker that signup is complete. If the broker does not halt,
     * navigate to the next screen.
     *
     * @param {Object} account
     * @returns {Promise}
     * @private
     */
    _notifyBrokerAndComplete (account) {
      this.logViewEvent('verification.success');
      this.notifier.trigger('verification.success');

      // Update the stored account data in case it was
      // updated by completeAccountSignUp.
      return this.user.setAccount(account)
        .then(() => {
          const brokerMethod = this._getBrokerMethod();
          return this.invokeBrokerMethod(brokerMethod, account);
        });
    },

    _getBrokerMethod () {
      const methodKey = this.keyOfVerificationReason(this.model.get('type'));
      return CompleteSignUpView.BROKER_METHODS[methodKey];
    },

    /**
     * Handle any verification errors.
     *
     * @param {Error} err
     * @private
     */
    _handleVerificationErrors (err) {
      const verificationInfo = this._verificationInfo;

      if (AuthErrors.is(err, 'UNKNOWN_ACCOUNT')) {
        verificationInfo.markExpired();
        err = AuthErrors.toError('UNKNOWN_ACCOUNT_VERIFICATION');
      } else if (
          AuthErrors.is(err, 'INVALID_VERIFICATION_CODE') ||
          AuthErrors.is(err, 'INVALID_PARAMETER')) {

        // When coming from sign-in confirmation verification, show a
        // verification link expired error instead of damaged verification link.
        // This error is generated because the link has already been used.
        if (this.isSignIn()) {
          // Disable resending verification, can only be triggered from new sign-in
          verificationInfo.markUsed();
          err = AuthErrors.toError('REUSED_SIGNIN_VERIFICATION_CODE');
        } else {
          // These server says the verification code or any parameter is
          // invalid. The entire link is damaged.
          verificationInfo.markDamaged();
          err = AuthErrors.toError('DAMAGED_VERIFICATION_LINK');
        }
      } else {
        // all other errors show the standard error box.
        this.model.set('error', err);
      }

      this.logError(err);
    },

    /**
     * Check whether the user can resend a signup verification email to allow
     * users to recover from expired verification links.
     *
     * @returns {Boolean}
     * @private
     */
    _canResend () {
      // _hasResendSessionToken only returns `true` if the user signed up in the
      // same browser in which they opened the verification link.
      return !! this._hasResendSessionToken() && this.isSignUp();
    },

    /**
     * Returns whether a sessionToken exists for the user's email.
     * The sessionToken is not cached during view initialization so that
     * we can capture sessionTokens from accounts created (in this browser)
     * since the view was loaded.
     *
     * @returns {Boolean}
     * @private
     */
    _hasResendSessionToken () {
      return !! this.user.getAccountByEmail(this._email).get('sessionToken');
    },

    /**
     * Resend a signup verification link to the user. Called when a
     * user follows an expired verification link and clicks "resend"
     *
     * @returns {Promise}
     */
    resend () {
      const account = this.user.getAccountByEmail(this._email);
      return account.retrySignUp(this.relier, {
        resume: this.getStringifiedResumeToken(account)
      })
      .fail((err) => {
        if (AuthErrors.is(err, 'INVALID_TOKEN')) {
          return this.navigate('signup', {
            error: err
          });
        }

        // unexpected error, rethrow for display.
        throw err;
      });
    }
  }, {
    BROKER_METHODS: {
      SECONDARY_EMAIL_VERIFIED: 'afterCompleteAddSecondaryEmail',
      SIGN_IN: 'afterCompleteSignIn',
      SIGN_UP: 'afterCompleteSignUp',
    }
  });

  Cocktail.mixin(
    CompleteSignUpView,
    ConnectAnotherDeviceMixin,
    ExperimentMixin,
    ResendMixin,
    ResumeTokenMixin,
    UserAgentMixin,
    VerificationReasonMixin
  );

  module.exports = CompleteSignUpView;
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

define(function (require, exports, module) {
  'use strict';

  const $ = require('jquery');
  const AuthBroker = require('models/auth_brokers/base');
  const AuthErrors = require('lib/auth-errors');
  const Backbone = require('backbone');
  const chai = require('chai');
  const CropperImage = require('models/cropper-image');
  const jQuerySimulate = require('jquery-simulate'); //eslint-disable-line no-unused-vars
  const Metrics = require('lib/metrics');
  const Notifier = require('lib/channels/notifier');
  const p = require('lib/promise');
  const ProfileMock = require('../../../mocks/profile');
  const Relier = require('models/reliers/relier');
  const sinon = require('sinon');
  const TestHelpers = require('../../../lib/helpers');
  const ui = require('draggable'); //eslint-disable-line no-unused-vars
  const User = require('models/user');
  const View = require('views/settings/avatar_crop');

  var assert = chai.assert;
  var pngSrc = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAACZJREFUeNrtwQEBAAAAgiD' +
               '/r25IQAEAAAAAAAAAAAAAAAAAAADvBkCAAAEehacTAAAAAElFTkSuQmCC';

  describe('views/settings/avatar/crop', function () {
    var account;
    var broker;
    var metrics;
    var model;
    var notifier;
    var profileClientMock;
    var relier;
    var user;
    var view;

    beforeEach(function () {
      model = new Backbone.Model();
      notifier = new Notifier();
      metrics = new Metrics({ notifier });
      relier = new Relier();
      user = new User();

      broker = new AuthBroker({
        relier: relier
      });

      view = new View({
        broker: broker,
        model: model,
        notifier: notifier,
        relier: relier,
        user: user
      });
    });

    afterEach(function () {
      $(view.el).remove();
      view.destroy();
      metrics.destroy();
      view = null;
      profileClientMock = null;
      metrics = null;
    });

    describe('with session', function () {
      beforeEach(function () {
        sinon.stub(view, 'checkAuthorization').callsFake(function () {
          return p(true);
        });
        account = user.initAccount({
          accessToken: 'abc123',
          email: 'a@a.com',
          verified: true
        });
        sinon.stub(view, 'getSignedInAccount').callsFake(function () {
          return account;
        });
      });

      it('has no cropper image', function () {
        sinon.spy(view, 'navigate');
        return view.render()
          .then(function () {
            assert.isTrue(view.navigate.calledWith('settings/avatar/change'));
            assert.equal(view.navigate.args[0][1].error, AuthErrors.toMessage('UNUSABLE_IMAGE'));
          });
      });

      describe('with an image', function () {

        beforeEach(function () {
          var cropImg = new CropperImage({
            height: 100,
            src: pngSrc,
            type: 'image/png',
            width: 100
          });

          profileClientMock = new ProfileMock();
          model.set({
            cropImg: cropImg
          });

          view = new View({
            metrics: metrics,
            model: model,
            notifier: notifier,
            relier: relier,
            user: user
          });
          view.isUserAuthorized = function () {
            return p(true);
          };
          sinon.stub(view, 'getSignedInAccount').callsFake(function () {
            return account;
          });
          sinon.stub(account, 'profileClient').callsFake(function () {
            return p(profileClientMock);
          });
          sinon.stub(view, 'updateProfileImage').callsFake(function () {
            return p();
          });
        });

        it('has a cropper image', function () {
          return view.render()
            .then(function (rendered) {
              assert.isTrue(rendered);

              view.afterVisible();

              assert.equal(view.$('.cropper img').attr('src'), pngSrc);
            });
        });

        it('submits an image', function () {
          sinon.stub(profileClientMock, 'uploadAvatar').callsFake(function () {
            return p({
              id: 'foo',
              url: 'test'
            });
          });

          sinon.spy(view, 'navigate');

          return view.render()
            .then(function () {
              return view.afterVisible();
            })
            .then(function () {
              return view.submit();
            })
            .then(function (result) {
              assert.equal(view.updateProfileImage.args[0][0].get('url'), result.url);
              assert.equal(view.updateProfileImage.args[0][1], account);
              assert.equal(result.url, 'test');
              assert.equal(result.id, 'foo');
              assert.isTrue(view.navigate.calledWith('settings'));
              assert.isTrue(TestHelpers.isEventLogged(metrics,
                'settings.avatar.crop.submit.new'));
            });
        });

        it('properly tracks avatar change events', function () {
          // set the account to have an existing profile image id
          account.set('hadProfileImageSetBefore', true);
          sinon.stub(profileClientMock, 'uploadAvatar').callsFake(function () {
            return p({
              id: 'foo'
            });
          });

          return view.render()
            .then(function () {
              return view.afterVisible();
            })
            .then(function () {
              return view.submit();
            })
            .then(function () {
              assert.isTrue(TestHelpers.isEventLogged(metrics,
                'settings.avatar.crop.submit.change'));
              assert.isFalse(TestHelpers.isEventLogged(metrics,
                'settings.avatar.crop.submit.new'));
            });

        });

        it('logs a metric event on rotation', function () {
          return view.render()
            .then(function () {
              return view.afterVisible();
            })
            .then(function () {
              view.$('.controls > .rotate').click();
              assert.isTrue(TestHelpers.isEventLogged(metrics,
                'settings.avatar.crop.rotate.cw'));
            });
        });

        it('logs a metric event on translation', function () {
          return view.render()
            .then(function () {
              return view.afterVisible();
            })
            .then(function () {
              view.$('.cropper .ui-draggable').simulate('drag', { dx: 50, dy: 50 });
              assert.isTrue(TestHelpers.isEventLogged(metrics,
                'settings.avatar.crop.translate'));
            });
        });

        it('logs a metric event on zoom in', function () {
          return view.render()
            .then(function () {
              return view.afterVisible();
            })
            .then(function () {
              view.$('.controls > .zoom-in').click();
              assert.isTrue(TestHelpers.isEventLogged(metrics,
                'settings.avatar.crop.zoom.in'));
            });
        });

        it('logs a metric event on zoom out', function () {
          return view.render()
            .then(function () {
              return view.afterVisible();
            })
            .then(function () {
              view.$('.controls > .zoom-out').click();
              assert.isTrue(TestHelpers.isEventLogged(metrics,
                'settings.avatar.crop.zoom.out'));
            });
        });

        it('logs a metric event on zoom range change', function () {
          return view.render()
            .then(function () {
              return view.afterVisible();
            })
            .then(function () {
              view.$('.controls > .slider').change();
              assert.isTrue(TestHelpers.isEventLogged(metrics,
                'settings.avatar.crop.zoom.range'));
            });
        });
      });
    });
  });
});

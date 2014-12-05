/**
 * ui.ts
 *
 * Common User Interface state holder and changer.
 * TODO: firefox bindings.
 */
/// <reference path='user.ts' />
/// <reference path='../../uproxy.ts'/>
/// <reference path='../../interfaces/ui.d.ts'/>
/// <reference path='../../interfaces/browser-api.d.ts'/>
/// <reference path='../../networking-typings/communications.d.ts' />

declare var model         :UI.Model;

module UI {

  export var DEFAULT_USER_IMG = '../icons/contact-default.png';

  /**
   * Enumeration of mutually-exclusive view states.
   */
  export enum View {
    SPLASH = 0,
    ROSTER,
    USER,
    NETWORKS,
    SETTINGS,
  }

  /**
   * Enumeration of mutually-exclusive UI modes.
   */
  export enum Mode {
    GET = 0,
    SHARE
  }

  export interface Contacts {
    onlineTrustedUproxy :UI.User[];
    offlineTrustedUproxy :UI.User[];
    onlineUntrustedUproxy :UI.User[];
    offlineUntrustedUproxy :UI.User[];
    onlineNonUproxy :UI.User[];
    offlineNonUproxy :UI.User[];
  }

  /**
   * Structure of the uProxy UI model object:
   * TODO: Probably put the model in its own file.
   */
  export interface Model {
    networkNames :string[];
    onlineNetwork :UI.Network;
    contacts :Contacts;
    description :string;
  }

  /**
   * Specific to one particular Social network.
   */
  export interface Network {
    name   :string;
    // TODO(salomegeo): Add more information about the user.
    userId :string;
    imageData ?:string;
    userName ?:string;
    online :boolean;
    roster :{ [userId:string] :User }
  }

  /**
   * The User Interface class.
   *
   * Keeps persistent state between the popup opening and closing.
   * Manipulates the payloads received from UPDATES from the Core in preparation
   * for UI interaction.
   * Any COMMANDs from the UI should be directly called from the 'core' object.
   */
  export class UserInterface implements uProxy.UIAPI {
    public DEBUG = false;  // Set to true to show the model in the UI.

    public view :View;  // Appearance.

    // Current state within the splash (onboarding).  Needs to be part
    // of the ui object so it can be saved/restored when popup closes and opens.
    public splashState :number = 0;

    // TODO: Put this into the 'auth' service, which will eventually include
    // sas-rtc.
    public localFingerprint :string = null;

    // Instance you are getting access from.
    // Null if you are not getting access.
    public instanceGettingAccessFrom = null;

    // The instances you are giving access to.
    // Remote instances to add to this set are received in messages from Core.
    public instancesGivingAccessTo = {};

    public mode :Mode = Mode.GET;

    private mapInstanceIdToUserName_ = {};

    public gettingStatus :string = null;
    public sharingStatus :string = null;

    /**
     * UI must be constructed with hooks to Notifications and Core.
     * Upon construction, the UI installs update handlers on core.
     */
    constructor(
        public core   :uProxy.CoreAPI,
        public browserApi :BrowserAPI) {
      // TODO: Determine the best way to describe view transitions.
      this.view = View.SPLASH;  // Begin at the splash intro.

      // Attach handlers for UPDATES received from core.
      // TODO: Implement the rest of the fine-grained state updates.
      // (We begin with the simplest, total state update, above.)
      core.onUpdate(uProxy.Update.INITIAL_STATE, (state :Object) => {
        console.log('Received uProxy.Update.INITIAL_STATE:', state);
        model.networkNames = state['networkNames'];
        model.description = state['description'];
        // TODO: Implement this after a better payload message is implemented.
        // There is now a difference between the UI Model and the state object
        // from the core, so one-to-one mappinsg from the old json-patch code cannot
        // work.
      });

      // Add or update the online status of a network.
      core.onUpdate(uProxy.Update.NETWORK, this.syncNetwork_);

      // Attach handlers for USER updates.
      core.onUpdate(uProxy.Update.USER_SELF, (payload :UI.UserMessage) => {
        // Instead of adding to the roster, update the local user information.
        console.log('uProxy.Update.USER_SELF:', payload);
        if (!model.onlineNetwork ||
            payload.network != model.onlineNetwork.name) {
          console.error('uProxy.Update.USER_SELF message for invalid network',
              payload.network);
          return;
        }
        var profile :UI.UserProfileMessage = payload.user;
        model.onlineNetwork.userId = profile.userId;
        model.onlineNetwork.imageData = profile.imageData;
        model.onlineNetwork.userName = profile.name;
      });
      core.onUpdate(uProxy.Update.USER_FRIEND, (payload :UI.UserMessage) => {
        console.log('uProxy.Update.USER_FRIEND:', payload);
        this.syncUser(payload);
      });
      core.onUpdate(uProxy.Update.ERROR, (errorText :string) => {
        console.warn('uProxy.Update.ERROR: ' + errorText);
        this.showNotification(errorText);
      });
      core.onUpdate(uProxy.Update.NOTIFICATION, (notificationText :string) => {
        console.warn('uProxy.Update.NOTIFICATION: ' + notificationText);
        this.showNotification(notificationText);
      });

      core.onUpdate(uProxy.Update.LOCAL_FINGERPRINT, (payload :string) => {
        this.localFingerprint = payload;
        console.log('Received local fingerprint: ' + this.localFingerprint);
      });

      core.onUpdate(uProxy.Update.MANUAL_NETWORK_OUTBOUND_MESSAGE,
                    (message :uProxy.Message) => {
        console.log('Manual network outbound message: ' +
                    JSON.stringify(message));
        // TODO: Display the message in the 'manual network' UI.
      });

      core.onUpdate(uProxy.Update.STOP_GETTING_FROM_FRIEND,
          (data :any) => {
        if (data.instanceId === this.instanceGettingAccessFrom) {
          this.instanceGettingAccessFrom = null;
          this.stopGettingInUiAndConfig(data.error);
          this.updateGettingStatusBar();
        } else {
          console.warn('Can\'t stop getting access from friend you were not ' +
              'already getting access from.');
        }
      });

      core.onUpdate(uProxy.Update.START_GIVING_TO_FRIEND,
          (instanceId :string) => {
        // TODO (lucyhe): Update instancesGivingAccessTo before calling
        // startGivingInUi so that isGiving() is updated as early as possible.
        if (!this.isGivingAccess()) {
          this.startGivingInUi();
        }
        this.instancesGivingAccessTo[instanceId] = true;
        this.updateSharingStatusBar();
      });

      core.onUpdate(uProxy.Update.STOP_GIVING_TO_FRIEND,
          (instanceId :string) => {
        delete this.instancesGivingAccessTo[instanceId];
        if (!this.isGivingAccess()) {
          this.stopGivingInUi();
        }
        this.updateSharingStatusBar();
      });

      console.log('Created the UserInterface');
    }

    public updateGettingStatusBar = () => {
      // TODO: localize this.
      if (this.instanceGettingAccessFrom) {
        var userName =
            this.mapInstanceIdToUserName_[this.instanceGettingAccessFrom];
        if (userName) {
          this.gettingStatus = 'Getting access from ' + userName;
        } else {
          this.gettingStatus = null;
          console.error('unable to find user name for instance ' +
              this.instanceGettingAccessFrom);
        }
      } else {
        this.gettingStatus = null;
      }
    }

    public updateSharingStatusBar = () => {
      // TODO: localize this - may require simpler formatting to work
      // in all languages.
      var instanceIds = Object.keys(this.instancesGivingAccessTo);
      if (instanceIds.length === 0) {
        this.sharingStatus = null;
      } else if (instanceIds.length === 1) {
        this.sharingStatus = 'Sharing access with ' +
            this.mapInstanceIdToUserName_[instanceIds[0]];
      } else if (instanceIds.length === 2) {
        this.sharingStatus = 'Sharing access with ' +
            this.mapInstanceIdToUserName_[instanceIds[0]] + ' and ' +
            this.mapInstanceIdToUserName_[instanceIds[1]];
      } else {
        this.sharingStatus = 'Sharing access with ' +
            this.mapInstanceIdToUserName_[instanceIds[0]] + ' and ' +
            (instanceIds.length - 1) + ' others';
      }
    }

    public showNotification = (notificationText :string) => {
      new Notification('uProxy', { body: notificationText,
                                   icon: 'icons/uproxy-128.png'});
    }

    /**
     * Removes proxy indicators from UI and undoes proxy configuration
     * (e.g. chrome.proxy settings).
     * If user didn't end proxying, so if proxy session ended because of some
     * unexpected reason, user should be asked before reverting proxy settings.
     */
    public stopGettingInUiAndConfig = (askUser :boolean) => {
      // TODO (lucyhe): if askUser is true we might want a different
      // icon that means "configured to proxy, but not proxying"
      // instead of immediately going back to the "not proxying" icon.
      if (this.isGivingAccess()) {
        this.browserApi.setIcon('sharing-19.png');
      } else if (askUser) {
        this.browserApi.setIcon('error-19.png');
      } else {
        this.browserApi.setIcon('default-19.png');
      }
      this.browserApi.stopUsingProxy(askUser);
    }

    /**
      * Sets extension icon to default and undoes proxy configuration.
      */
    public startGettingInUiAndConfig = (endpoint:Net.Endpoint) => {
      if (this.isGivingAccess()) {
        this.browserApi.setIcon('sharing-getting-19.png');
      } else {
        this.browserApi.setIcon('getting-19.png');
      }
      this.browserApi.startUsingProxy(endpoint);
    }

    /**
      * Set extension icon to the 'giving' icon.
      */
    public startGivingInUi = () => {
      if (this.isGettingAccess()) {
        this.browserApi.setIcon('sharing-getting-19.png');
      } else {
        this.browserApi.setIcon('sharing-19.png');
      }
    }

    /**
      * Set extension icon to the default icon.
      */
    public stopGivingInUi = () => {
      if (this.isGettingAccess()) {
        this.browserApi.setIcon('getting-19.png');
      } else {
        this.browserApi.setIcon('default-19.png');
      }
    }

    public setOfflineIcon = () => {
      this.browserApi.setIcon('offline-19.png');
    }

    public isGettingAccess = () => {
      return this.instanceGettingAccessFrom != null;
    }

    public isGivingAccess = () => {
      return Object.keys(this.instancesGivingAccessTo).length > 0;
    }

    /**
     * Synchronize a new network to be visible on this UI.
     */
    private syncNetwork_ = (network :UI.NetworkMessage) => {
      console.log('uProxy.Update.NETWORK', network);
      console.log('model: ', model);

      // If you are now online (on a non-manual network), and were
      // previously offline, show the default (logo) icon.
      if (network.online && network.name != 'Manual'
          && model.onlineNetwork == null) {
        this.browserApi.setIcon('default-19.png');
      }

      if (model.onlineNetwork &&
          (network.online && network.name != model.onlineNetwork.name) ||
          (!network.online && network.name == model.onlineNetwork.name)) {
        // onlineNetwork exists and has either been changed or logged out.
        // Clear roster and option user info from offline network.
        for (var userId in model.onlineNetwork.roster) {
          var user = model.onlineNetwork.roster[userId];
          this.categorizeUser_(user, user.getCategory(), null);
        }
        model.onlineNetwork = null;
      }

      if (network.online && !model.onlineNetwork) {
        model.onlineNetwork = {
          name:   network.name,
          userId: network.userId,
          online: network.online,
          roster: {}
        };
      }
    }

    // Synchronize the data about the current user.
    // TODO: Be able to sync local instance, per network.

    /**
     * Synchronize data about some friend.
     */
    public syncUser = (payload :UI.UserMessage) => {
      if (!model.onlineNetwork || model.onlineNetwork.name != payload.network) {
        // Ignore all user updates when the network is offline.
        // These user updates may come in asynchrously after logging out of a
        // network, e.g. if the UI logs out of Google while we are getting
        // access, we will first completely logout and then asynchronously
        // get an update for the user when the peerconnection has closed - in
        // this case the user should already have been removed from the roster
        // in the UI and stay removed.
        return;
      }

      // Construct a UI-specific user object.
      var profile = payload.user;
      // Update / create if necessary a user, both in the network-specific
      // roster and the global roster.
      var user :UI.User;
      user = model.onlineNetwork.roster[profile.userId];
      var oldCategory = null;

      // CONSIDER: we might want to check if this user has been our proxy
      // server and if so stop the proxying if they are no longer proxying
      // for us (e.g. they were disconnected).  Currently we are sending an
      // explicit stop proxy message from the app to stop proxying.
      if (!user) {
        // New user.
        user = new UI.User(profile.userId, model.onlineNetwork);
        model.onlineNetwork.roster[profile.userId] = user;
      } else {
        // Existing user, get the category before modifying any properties.
        oldCategory = user.getCategory();
      }

      user.update(profile);
      user.instances = payload.instances;
      for (var i = 0; i < user.instances.length; ++i) {
        var instanceId = user.instances[i].instanceId;
        this.mapInstanceIdToUserName_[instanceId] = user.name;
      }

      var newCategory = user.getCategory();
      this.categorizeUser_(user, oldCategory, newCategory);

      console.log('Synchronized user.', user);
    };

    private categorizeUser_ = (user, oldCategory, newCategory) => {
      if (oldCategory == null) {
        // User hasn't yet been categorized.
        model.contacts[newCategory].push(user);
      } else if (oldCategory != newCategory) {
        // Remove user from old category.
        var oldCategoryArray = model.contacts[oldCategory];
        for (var i = 0; i < oldCategoryArray.length; ++i) {
          if (oldCategoryArray[i] == user) {
            oldCategoryArray.splice(i, 1);
            break;
          }
        }
        // Add users to new category.
        if (newCategory) {
          model.contacts[newCategory].push(user);
        }
      }
    }

    public openFaq = (pageAnchor ?:string) => {
      this.browserApi.openFaq(pageAnchor);
    }
  }  // class UserInterface

}  // module UI

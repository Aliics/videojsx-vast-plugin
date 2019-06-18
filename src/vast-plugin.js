import videojs from 'video.js';
import 'videojs-contrib-ads'; // Contrib Ads plugin registers itself
import { VASTClient, VASTTracker } from 'vast-client'


const Plugin = videojs.getPlugin('plugin');

function createSourceObjects(mediaFiles) {
  return mediaFiles.map(mediaFile => ({type: mediaFile.mimeType, src: mediaFile.fileURL}));
}

const defaultOptions = {
  seekEnabled: false,
  controlsEnabled: false,
  wrapperLimit: 10,
  withCredentials: true
};

export default class VastPlugin extends Plugin {
  constructor(player, options) {
    super(player);

    player.ads({debug:true});

    options = videojs.mergeOptions(defaultOptions, options || {});

    this.options = options;

    this.vastClient = new VASTClient();
    this.originalPlayerState = {};
    this.eventListeners = {};
    this.domElements = {};

    player.one('play', () => {
      player.error(null);
      this._getVastContent(options.url);
      console.log('play');

        if (options.url !== undefined) {
            this._getVastContent(options.url)
        } else if (options.vast !== undefined) {
            this._handleVast(options.vast, options);
        }
    });

    player.on('contentchanged', () => {
      console.log("Content changed");
    });


    player.on('readyforpreroll', () => {
      if (!options.url && !options.vast) { // this kept cancelling our advertisement from being played with direct VAST data.
        player.trigger('adscanceled');
        return;
      }

      this._doPreroll();
    });

  }

  _handleVast(res, options) { // TODO it might be worth checking if a video companion is actually found in the VAST data.
      console.log('vast: ', res)

      const linearFn = creative => creative.type === 'linear';
      const companionFn = creative => creative.type === 'companion';
      const adWithLinear = res.ads.find(ad => ad.creatives.some(linearFn));
      const linearCreative = adWithLinear.creatives.find(linearFn);
      console.log("linear: ", linearCreative )
      const companionCreative = adWithLinear.creatives.find(companionFn);

      if (options.companion) {
          const variation = companionCreative.variations.find(v => v.width === String(options.companion.maxWidth) && v.height === String(options.companion.maxHeight));
          if (variation) {
              if (variation.staticResource) {
                  if (variation.type.indexOf("image") === 0) {
                      const clickThroughUrl = variation.companionClickThroughURLTemplate;
                      const dest = document.getElementById(options.companion.elementId);
                      let html;
                      if (clickThroughUrl) {
                          html = `<a href="${clickThroughUrl}" target="_blank"><img src="${variation.staticResource}"/></a>`
                      } else {
                          html = `<img src="${variation.staticResource}"/>`;
                      }
                      dest.innerHTML = html;
                  } else if (["application/x-javascript", "text/javascript", "application/javascript"].indexOf(variation.type) > -1) {
                      // handle script
                  } else if (variation.type === "application/x-shockwave-flash") {
                      // handle flash
                  }
              }
          }
      }

      // console.log("RESULT: " + JSON.stringify(companionCreative));

      this.sources = createSourceObjects(linearCreative.mediaFiles);

      this.tracker = new VASTTracker(this.vastClient, adWithLinear, linearCreative, companionCreative);

      if (this.sources.length) {
          this.player.trigger('adsready');
      }
      else {
          this.player.trigger('adscanceled');
      }
  }

  _getVastContent(url) {
    const options = this.options;
    //This is doing more work than new VASTParser().parseVAST(xmlDoc).
    this.vastClient.get(url, {withCredentials: options.withCredentials, wrapperLimit: options.wrapperLimit})
      .then(res => {
            this._handleVast(res, options)
      })
      .catch(err => {
        this.player.trigger('adscanceled');
        console.error(err);
      });
  }

  _doPreroll() {
    const player = this.player;
    const options = this.options;

    player.ads.startLinearAdMode();

    this.originalPlayerState.controlsEnabled = player.controls();
    player.controls(options.controlsEnabled);

    this.originalPlayerState.seekEnabled = player.controlBar.progressControl.enabled();
    if (options.seekEnabled) {
      player.controlBar.progressControl.enable();
    }
    else {
      player.controlBar.progressControl.disable();
    }


    player.src(this.sources);

    const blocker = window.document.createElement('div');
    blocker.className = 'vast-blocker';
    blocker.onclick = () => {
      if (player.paused()) {
        player.play();
        return false;
      }
      this.tracker.click();
    };


    this.tracker.on('clickthrough', url => {
      window.open(url, '_blank');
    });

    this.domElements.blocker = blocker;
    player.el().insertBefore(blocker, player.controlBar.el());

    const skipButton = window.document.createElement('div');
    skipButton.className = 'vast-skip-button';
    skipButton.style.display = 'none';
    this.domElements.skipButton = skipButton;
    player.el().appendChild(skipButton);


    this.eventListeners.adtimeupdate = () => this._timeUpdate();
    player.one('adplay', () => {
      if (this.options.skip > 0 && player.duration() >= this.options.skip) {
        skipButton.style.display = 'block';
        player.on('adtimeupdate', this.eventListeners.adtimeupdate);
      }
    });

    this.eventListeners.teardown = () => this._tearDown();

    skipButton.onclick = (e) => {
      if((' ' + skipButton.className + ' ').indexOf(' enabled ') >= 0) {
        this.tracker.skip();
        this.eventListeners.teardown();
      }
      if(window.Event.prototype.stopPropagation !== undefined) {
        e.stopPropagation();
      }
      else {
        return false;
      }
    };

    this._setupEvents();

    player.one('adended', this.eventListeners.teardown);
  }

  _timeUpdate () {
    const player = this.player;
    player.loadingSpinner.el().style.display = 'none';
    const timeLeft = Math.ceil(this.options.skip - player.currentTime());
    if(timeLeft > 0) {
      this.domElements.skipButton.innerHTML = 'Skip in ' + timeLeft + '...';
    } else {
      if((' ' + this.domElements.skipButton.className + ' ').indexOf(' enabled ') === -1) {
        this.domElements.skipButton.className += ' enabled ';
        this.domElements.skipButton.innerHTML = 'Skip';
      }
    }
  }

  _tearDown() {
    Object.values(this.domElements).forEach(el => el.parentNode.removeChild(el));
    const player = this.player;

    player.off('adtimeupdate', this.eventListeners.adtimeupdate);

    player.ads.endLinearAdMode();

    player.controls(this.originalPlayerState.controlsEnabled);

    if (this.originalPlayerState.seekEnabled) {
      player.controlBar.progressControl.enable();
    }
    else {
      player.controlBar.progressControl.disable();
    }

    player.trigger('vast-done');
  }

  _setupEvents() {
    const player = this.player;
    const tracker = this.tracker;

    let errorOccurred = false;

    const canplayFn = function() {
        tracker.trackImpression();
    };

    const timeupdateFn = function() {
        if (isNaN(tracker.assetDuration)) {
          tracker.assetDuration = player.duration();
        }
        tracker.setProgress(player.currentTime());
    };

    const pauseFn = function () {
      tracker.setPaused(true);
      player.one('adplay', function () {
        tracker.setPaused(false);
      });
    };

    const errorFn = function () {
      const MEDIAFILE_PLAYBACK_ERROR = '405';
      tracker.errorWithCode(MEDIAFILE_PLAYBACK_ERROR);
      errorOccurred = true;
      // Do not want to show VAST related errors to the user
      player.error(null);
      player.trigger('adended');
    };

    const fullScreenFn = function() {
      // for 'fullscreen' & 'exitfullscreen'
      tracker.setFullscreen(player.isFullscreen());
    };

    const muteFn = (function(){
      let previousMuted = player.muted();
      let previousVolume = player.volume();

      return function() {
        const volumeNow = player.volume();
        const mutedNow = player.muted();

        if (previousMuted !== mutedNow) {
          tracker.setMuted(mutedNow);
          previousMuted = mutedNow;
        }
        else if (previousVolume !== volumeNow) {
          if (previousVolume > 0 && volumeNow === 0) {
            tracker.setMuted(true);
          }
          else if (previousVolume === 0 && volumeNow > 0) {
            tracker.setMuted(false);
          }

          previousVolume = volumeNow;
        }
      }
    })();

    player.on('adcanplay', canplayFn);
    player.on('adtimeupdate', timeupdateFn);
    player.on('adpause', pauseFn);
    player.on('aderror', errorFn);
    player.on('advolumechange', muteFn);
    player.on('fullscreenchange', fullScreenFn);


    player.one('vast-done', function() {
      player.off('adcanplay', canplayFn);
      player.off('adtimeupdate', timeupdateFn);
      player.off('adpause', pauseFn);
      player.off('aderror', errorFn);
      player.off('advolumechange', muteFn);
      player.off('fullscreenchange', fullScreenFn);

      if (!errorOccurred) {
        tracker.complete();
      }
    });
  }
}

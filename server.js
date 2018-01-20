
import express from 'express';
import expressLogging from 'express-logging';
import expressAsync from 'express-async-await';
import crypto from 'crypto';
import logger from 'logops';
import redis from 'redis';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';
import pifall from 'pifall';
import fs from 'fs';
import http from 'http';
import sha1 from 'sha1';
import passport from 'passport';
import FacebookStrategy from 'passport-facebook';
import GoogleStrategy from 'passport-google-oauth20';

const ovi_config = {
  wsbase: ( process.env.WSBASE ? process.env.WSBASE : 'http://localhost:8080' ),
  ip_header: ( process.env.CLIENT_IP_HEADER ? process.env.CLIENT_IP_HEADER : 'x-client-ip' ),
  redis_host: ( process.env.REDIS_HOST ? process.env.REDIS_HOST : 'localhost' ),
  redis_port: ( process.env.REDIS_PORT ? process.env.REDIS_PORT : 6379 ),
  jwt_secret: ( process.env.JWS_SECRET ? process.env.JWS_SECRET : crypto.randomBytes(48).toString('hex') ),
  jwt_iss: ( process.env.JWS_ISS ? process.env.JWS_ISS : 'ourvoiceusa.org' ),
  api_key_google: ( process.env.API_KEY_GOOGLE ? process.env.API_KEY_GOOGLE : missingConfig("API_KEY_GOOGLE") ),
  DEBUG: ( process.env.DEBUG ? process.env.DEBUG : false ),
};

const passport_facebook = {
  clientID: ( process.env.OAUTH_FACEBOOK_CLIENTID ? process.env.OAUTH_FACEBOOK_CLIENTID : missingConfig("OAUTH_FACEBOOK_CLIENTID") ),
  clientSecret: ( process.env.OAUTH_FACEBOOK_SECRET ? process.env.OAUTH_FACEBOOK_SECRET : missingConfig("OAUTH_FACEBOOK_SECRET") ),
  enableProof: true,
  state: true,
  profileFields: ['id', 'name', 'displayName', 'picture', 'emails'],
};

const passport_google = {
  clientID: ( process.env.OAUTH_GOOGLE_CLIENTID ? process.env.OAUTH_GOOGLE_CLIENTID : missingConfig("OAUTH_GOOGLE_CLIENTID") ),
  clientSecret: ( process.env.OAUTH_GOOGLE_SECRET ? process.env.OAUTH_GOOGLE_SECRET : missingConfig("OAUTH_GOOGLE_SECRET") ),
  state: true,
};

// async'ify redis
pifall(redis.RedisClient.prototype);
pifall(redis.Multi.prototype);

// Transform Facebook profile because Facebook and Google profile objects look different
// and we want to transform them into user objects that have the same set of attributes
const transformFacebookProfile = (profile) => ({
  id: 'facebook:' + profile.id,
  name: profile.name,
  email: (profile.email?profile.email:''),
  avatar: (profile.picture.data.url?profile.picture.data.url:''),
  iss: ovi_config.jwt_iss,
  iat: Math.floor(new Date().getTime() / 1000),
  exp: Math.floor(new Date().getTime() / 1000)+604800,
});

// Transform Google profile into user object
const transformGoogleProfile = (profile) => ({
  id: 'google:' + profile.id,
  name: profile.displayName,
  email: (profile.emails[0].value?profile.emails[0].value:''),
  avatar: (profile.image.url?profile.image.url:''),
  iss: ovi_config.jwt_iss,
  iat: Math.floor(new Date().getTime() / 1000),
  exp: Math.floor(new Date().getTime() / 1000)+604800,
});

// Register Facebook Passport strategy
passport.use(new FacebookStrategy(passport_facebook,
  async (accessToken, refreshToken, profile, done)
    => done(null, transformFacebookProfile(profile._json))
));

// Register Google Passport strategy
passport.use(new GoogleStrategy(passport_google,
  async (accessToken, refreshToken, profile, done)
    => done(null, transformGoogleProfile(profile._json))
));

// Serialize user into the sessions
passport.serializeUser((user, done) => done(null, user));

// Deserialize user from the sessions
passport.deserializeUser((user, done) => done(null, user));

// redis connection
var rc = redis.createClient(ovi_config.redis_port, ovi_config.redis_host,
  {
    // endlessly retry the database connection
    retry_strategy: function (options) {
      console.log('redis connection failed to "'+ovi_config.redis_host+'", retrying: this is attempt # '+options.attempt);
      return Math.min(options.attempt * 100, 3000);
    }
  }
);

rc.on('connect', async function() {
    console.log('Connected to redis at host "'+ovi_config.redis_host+'"');
});

function missingConfig(item) {
  let msg = "Missing config: "+item;
  console.log(msg);
  throw msg;
}

async function dbwrap() {
    var params = Array.prototype.slice.call(arguments);
    var func = params.shift();
    if (ovi_config.DEBUG) {
      let funcName = func.replace('Async', '');
      console.log('DEBUG: '+funcName+' '+params.join(' '));
    }
    return rc[func](params);
}

function wslog(req, ws, log) {
  log['client-ip'] = req.header(ovi_config.ip_header);
  log['time'] = (new Date).getTime();
  let str = JSON.stringify(log);
  if (ovi_config.DEBUG) console.log('DEBUG: '+ws+': '+str);
  try {
    rc.lpush('wslog:'+ws, str);
  } catch (error) {
    console.log(error);
  }
}

async function dinfo(req, res) {
  var resp;
  var token;
  var user = {};
  var error;
  try {
    token = req.header('authorization').split(' ')[1];;
    user = jwt.decode(token);
    rc.sadd('dinfo:'+user.id, JSON.stringify(req.body));
    resp = await dbwrap('hgetallAsync', 'user:'+user.id);
  } catch (e) {
    error = 1;
    console.log(e);
  }
  if (ovi_config.DEBUG)
    console.log(JSON.stringify(resp))
  wslog(req, 'dinfo', {UniqueID: req.body.UniqueID, user_id: user.id, error: error});
  res.send(resp);
}

async function dprofile(req, res) {
  var resp;
  var error;
  var user = {};
  try {
    let token = req.header('authorization').split(' ')[1];;
    user = jwt.decode(token);

    // TODO: input validation

    // TODO: multi / exec for atomic

    if (req.body.party) {
      let partyOld = await dbwrap('hgetAsync', 'user:'+user.id, 'party');
      if (partyOld !== req.body.party) {
        await dbwrap('hsetAsync', 'user:'+user.id, 'party', req.body.party);

        // fix party affiliations in all this user's ratings
        var ratings = await dbwrap('smembersAsync', 'user:'+user.id+':politician_ratings');

        for (let i = 0; i < ratings.length; i++) {
          let politician_id = ratings[i];
          let rating = await dbwrap('zscoreAsync', 'politician:'+politician_id+':rating:'+partyOld, user.id);
          if (rating) {
            await dbwrap('zremAsync', 'politician:'+politician_id+':rating:'+partyOld, user.id);
            await dbwrap('zaddAsync', 'politician:'+politician_id+':rating:'+req.body.party, rating, user.id);
          }

          // now try the other rating key
          rating = await dbwrap('zscoreAsync', 'politician:'+politician_id+':rating_outsider:'+partyOld, user.id);
          if (rating) {
            await dbwrap('zremAsync', 'politician:'+politician_id+':rating_outsider:'+partyOld, user.id);
            await dbwrap('zaddAsync', 'politician:'+politician_id+':rating_outsider:'+req.body.party, rating, user.id);
          }
        }
      }
    }

    if (req.body.address && req.body.lng && req.body.lat) {
      // get this user's address prior to update
      var arr = await dbwrap('hmgetAsync', 'user:'+user.id, 'home_lng', 'home_lat');

      // set new address
      await dbwrap('hmsetAsync',
        'user:'+user.id,
        'home_address', req.body.address, 
        'home_lng', req.body.lng,
        'home_lat', req.body.lat
      );

      // go through everyone this user has rated and see if they're still in the district
      var incumbents = await dbwrap('smembersAsync', 'user:'+user.id+':politician_ratings');
      var party = await getUserParty(user.id);
      for (let i = 0; i < incumbents.length; i++) {
        var rating;
        if (await userInPolDistrict(incumbents[i], user.id, req.body.lng, req.body.lat)) {
          rating = await dbwrap('zscoreAsync', 'politician:'+incumbents[i]+':rating_outsider:'+party, user.id);
          if (rating) {
            await dbwrap('zremAsync', 'politician:'+incumbents[i]+':rating_outsider:'+party, user.id);
            await dbwrap('zaddAsync', 'politician:'+incumbents[i]+':rating:'+party, rating, user.id);
          }
        } else {
          rating = await dbwrap('zscoreAsync', 'politician:'+incumbents[i]+':rating:'+party, user.id);
          if (rating) {
            await dbwrap('zremAsync', 'politician:'+incumbents[i]+':rating:'+party, user.id);
            await dbwrap('zaddAsync', 'politician:'+incumbents[i]+':rating_outsider:'+party, rating, user.id);
          }
        }
      }
    }
  } catch (e) {
    error = 1;
    console.log(e);
  }

  wslog(req, 'dprofile', {user_id: user.id, party: req.body.party, address: req.body.address, lng: req.body.lng, lat: req.body.lat, error: error});

  res.send('OK');
}

async function getRatings(politician_id, user_id) {
    var ratings = { outsider: {} };
    var parties = ['D', 'R', 'I', 'G', 'L', 'O']; // TODO: dictionary, other countries have diff party mappings
    for (let i = 0; i < parties.length; i++) {
      var party = parties[i];
      var star1 = await rc.zcountAsync('politician:'+politician_id+':rating:'+party, 1, 1);
      var star2 = await rc.zcountAsync('politician:'+politician_id+':rating:'+party, 2, 2);
      var star3 = await rc.zcountAsync('politician:'+politician_id+':rating:'+party, 3, 3);
      var star4 = await rc.zcountAsync('politician:'+politician_id+':rating:'+party, 4, 4);
      var star5 = await rc.zcountAsync('politician:'+politician_id+':rating:'+party, 5, 5);
      var total = star1+star2+star3+star4+star5;
      var rating = 0;

      if (!total) total = 0;
      else rating = (star1+(star2*2)+(star3*3)+(star4*4)+(star5*5))/total;

      ratings[party] = { rating: rating, total: total };

      // my apologies for copy/pasted code ... :(
      star1 = await rc.zcountAsync('politician:'+politician_id+':rating_outsider:'+party, 1, 1);
      star2 = await rc.zcountAsync('politician:'+politician_id+':rating_outsider:'+party, 2, 2);
      star3 = await rc.zcountAsync('politician:'+politician_id+':rating_outsider:'+party, 3, 3);
      star4 = await rc.zcountAsync('politician:'+politician_id+':rating_outsider:'+party, 4, 4);
      star5 = await rc.zcountAsync('politician:'+politician_id+':rating_outsider:'+party, 5, 5);
      total = star1+star2+star3+star4+star5;
      rating = 0;

      if (!total) total = 0;
      else rating = (star1+(star2*2)+(star3*3)+(star4*4)+(star5*5))/total;

      ratings.outsider[party] = { rating: rating, total: total };
    }

    // include this user's rating too
    if (user_id) {
      ratings.user = await dbwrap('zscoreAsync', 'politician:'+politician_id+':rating:'+await getUserParty(user_id), user_id);
      if (!ratings.user) {
        ratings.user = await dbwrap('zscoreAsync', 'politician:'+politician_id+':rating_outsider:'+await getUserParty(user_id), user_id);
      }
      if (!ratings.user) ratings.user = 0;
    }

    return ratings;
}

async function getUserParty(user_id) {
  let party = await dbwrap('hgetAsync', 'user:'+user_id, 'party');
  if (!party) party = 'I';
  return party;
}

async function userInPolDistrict(politician_id, user_id, lng, lat) {
  // need to save districts on 'whorepme'

  return false;
}

async function politician_rate(req, res) {
  var resp = {msg: 'Error'};
  var user;
  var politician_id;
  var rating;
  var error;
  try {
    let token = req.header('authorization').split(' ')[1];;
    user = jwt.decode(token);
    politician_id = req.body.politician_id;
    rating = req.body.rating;
    let lng = req.body.lng;
    let lat = req.body.lat;

    if (!politician_id || !user.id) {
      throw 'Invalid Input.';
    }

    // rating is optional
    if (rating) {
      // keep track of which politicians this users has rated so we can cleanup if they change party or district
      await dbwrap('sadd', 'user:'+user.id+':politician_ratings', politician_id);
      if (await userInPolDistrict(politician_id, user.id, lng, lat))
        await dbwrap('zaddAsync', 'politician:'+politician_id+':rating:'+await getUserParty(user.id), rating, user.id);
      else
        await dbwrap('zaddAsync', 'politician:'+politician_id+':rating_outsider:'+await getUserParty(user.id), rating, user.id);
    }

    resp = await getRatings(politician_id, user.id);

  } catch (e) {
    console.log(e);
    error = 1;
  }

  if (ovi_config.DEBUG)
    console.log(JSON.stringify(resp));

  wslog(req, 'politician_rate', {user_id: user.id, politician_id: politician_id, rating: rating, error: error});
  res.send(resp);
}

async function whorepme(req, res) {
  var resp = {
    federal: { offices: [] },
    state: { offices: []},
    local: { offices: []},
  };

  var office;
  var error;
  var user = {};

  let lng = Number.parseFloat(req.query.lng);
  let lat = Number.parseFloat(req.query.lat);

  if (isNaN(lng) || isNaN(lat)) {
    resp = { msg: "Invalid input.", error: 1 };
    wslog(req, 'whorepme', resp);
    res.send(resp);
    return;
  }

  // TODO: use Google Civic API

  if (ovi_config.DEBUG) console.log(JSON.stringify(resp));

  wslog(req, 'whorepme', {lng: lng, lat: lat, address: req.body.address, user_id: user.id, error: error});
  res.header('Access-Control-Allow-Origin', '*');
  res.send(resp);
}

// Redirect user back to the mobile app using Linking with a custom protocol OAuthLogin
function oauthredir(req, res, type) {
  req.user.sub = req.user.id; // the jwt "subject" is the userid
  var u = JSON.stringify(req.user);
  rc.lpush('jwt:'+req.user.id, u);
  rc.hmset('user:'+req.user.id, 'name', req.user.name, 'email', req.user.email, 'avatar', req.user.avatar);
  wslog(req, 'oauthredir', {user_id: req.user.id, type: type});
  return u;
}

function moauthredir(req, res) {
  var u = oauthredir(req, res, 'mobile');
  res.redirect('OurVoiceApp://login?jwt=' + jwt.sign(u, ovi_config.jwt_secret));
}

async function poke(req, res) {
  try {
    var pong = await dbwrap('pingAsync', 'pong');
    if (pong == 'pong') return res.sendStatus(200);
  } catch (e) {
  }
  return res.sendStatus(500);
}

// Initialize http server
const app = expressAsync(express());
app.use(expressLogging(logger));
app.use(bodyParser.json());

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// imagine cache
app.use(express.static('images'))

// require ip_header
// TODO: option to just use req.connection.remoteAddress instead
if (!ovi_config.DEBUG) {
  app.use(function (req, res, next) {
    if (!req.header(ovi_config.ip_header)) {
      console.log('Connection without '+ovi_config.ip_header+' header');
      res.status(400).send();
    }
    else next();
  });
}

// internal routes
app.get('/poke', poke);

// ws routes
app.post('/api/protected/dinfo', dinfo);
app.post('/api/protected/dprofile', dprofile);
app.post('/api/protected/politician_rate', politician_rate);
app.post('/api/dinfo', dinfo);
app.get('/api/whorepme', whorepme);

// Set up auth routes
app.get('/auth/fm', passport.authenticate('facebook', { callbackURL: ovi_config.wsbase+'/auth/fm/callback', scope: ['email']} ));
// google accepts the custom loginHint
app.get('/auth/gm', function(req, res, next) {
  passport.authenticate('google', { loginHint: req.query.loginHint, callbackURL: ovi_config.wsbase+'/auth/gm/callback', scope: ['profile', 'email'] }
  )(req, res, next)});
app.get('/auth/fm/callback', passport.authenticate('facebook', { callbackURL: ovi_config.wsbase+'/auth/fm/callback', failureRedirect: '/auth/fm' }), moauthredir);
app.get('/auth/gm/callback', passport.authenticate('google',   { callbackURL: ovi_config.wsbase+'/auth/gm/callback', failureRedirect: '/auth/gm' }), moauthredir);

// Launch the server
const server = app.listen(8080, () => {
  const { address, port } = server.address();
  console.log('databroker express');
  console.log(`Listening at http://${address}:${port}`);
});


import express from 'express';
import expressLogging from 'express-logging';
import expressAsync from 'express-async-await';
import cors from 'cors';
import crypto from 'crypto';
import logger from 'logops';
import redis from 'redis';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';
import pifall from 'pifall';
import fs from 'fs';
import http from 'http';
import sha1 from 'sha1';
import httpProxy from 'http-proxy';

const ovi_config = {
  server_port: ( process.env.SERVER_PORT ? process.env.SERVER_PORT : 8080 ),
  wsbase: ( process.env.WSBASE ? process.env.WSBASE : 'http://localhost:8080' ),
  ip_header: ( process.env.CLIENT_IP_HEADER ? process.env.CLIENT_IP_HEADER : null ),
  redis_host: ( process.env.REDIS_HOST ? process.env.REDIS_HOST : 'localhost' ),
  redis_port: ( process.env.REDIS_PORT ? process.env.REDIS_PORT : 6379 ),
  jwt_secret: ( process.env.JWS_SECRET ? process.env.JWS_SECRET : crypto.randomBytes(48).toString('hex') ),
  jwt_iss: ( process.env.JWS_ISS ? process.env.JWS_ISS : 'example.com' ),
  api_key_google: ( process.env.API_KEY_GOOGLE ? process.env.API_KEY_GOOGLE : missingConfig("API_KEY_GOOGLE") ),
  api_key_openstates: ( process.env.API_KEY_OPENSTATES ? process.env.API_KEY_OPENSTATES : missingConfig("API_KEY_OPENSTATES") ),
  img_cache_url: ( process.env.IMG_CACHE_URL ? process.env.IMG_CACHE_URL : null ),
  img_cache_opt: ( process.env.IMG_CACHE_OPT ? process.env.IMG_CACHE_OPT : null ),
  require_auth: ( process.env.AUTH_OPTIONAL ? false : true ),
  DEBUG: ( process.env.DEBUG ? true : false ),
};

// async'ify redis
pifall(redis.RedisClient.prototype);
pifall(redis.Multi.prototype);

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

function cleanobj(obj) {
  for (var propName in obj) {
    if (obj[propName] == '' || obj[propName] == null)
      delete obj[propName];
  }
}

function getClientIP(req) {
  if (ovi_config.ip_header) return req.header(ovi_config.ip_header);
  else return req.connection.remoteAddress;
}

function wslog(req, ws, log) {
  log['user_id'] = req.user.id;
  log['client_ip'] = getClientIP(req);
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
  var error;
  if (!req.user.id) return res.sendStatus(401);
  try {
    rc.sadd('dinfo:'+req.user.id, JSON.stringify(req.body));
    // update any changes from oauth to this user
    await dbwrap('hmsetAsync', 'user:'+req.user.id, 'name', req.user.name, 'email', req.user.email, 'avatar', req.user.avatar);
    resp = await dbwrap('hgetallAsync', 'user:'+req.user.id);
  } catch (e) {
    error = 1;
    console.log(e);
  }
  if (ovi_config.DEBUG)
    console.log(JSON.stringify(resp))
  wslog(req, 'dinfo', {UniqueID: req.body.UniqueID, error: error});
  res.send(resp);
}

async function dprofile(req, res) {
  var resp;
  var error;
  if (!req.user.id) return res.sendStatus(401);
  try {
    // TODO: input validation

    // TODO: multi / exec for atomic

    // not using getUserParty here because we need to know if it's null
    let partyOld = await dbwrap('hgetAsync', 'user:'+req.user.id, 'party');
    if (req.body.party && partyOld != req.body.party) {
      if (!partyOld || partyOld !== req.body.party) {
        if (!partyOld) partyOld = 'I'; // need this set for first time ratings
        await dbwrap('hsetAsync', 'user:'+req.user.id, 'party', req.body.party);

        // fix party affiliations in all this user's ratings
        var ratings = await dbwrap('smembersAsync', 'user:'+req.user.id+':politician_ratings');

        for (let i = 0; i < ratings.length; i++) {
          let politician_id = ratings[i];
          let rating = await dbwrap('zscoreAsync', 'politician:'+politician_id+':rating:'+partyOld, req.user.id);
          if (rating) {
            await dbwrap('zremAsync', 'politician:'+politician_id+':rating:'+partyOld, req.user.id);
            await dbwrap('zaddAsync', 'politician:'+politician_id+':rating:'+req.body.party, rating, req.user.id);
          }

          // now try the other rating key
          rating = await dbwrap('zscoreAsync', 'politician:'+politician_id+':rating_outsider:'+partyOld, req.user.id);
          if (rating) {
            await dbwrap('zremAsync', 'politician:'+politician_id+':rating_outsider:'+partyOld, req.user.id);
            await dbwrap('zaddAsync', 'politician:'+politician_id+':rating_outsider:'+req.body.party, rating, req.user.id);
          }
        }
      }
    }

    let home_address = await dbwrap('hgetAsync', 'user:'+req.user.id, 'home_address');
    if (req.body.address && req.body.address != home_address && req.body.lng && req.body.lat) {
      // set new address
      await dbwrap('hmsetAsync',
        'user:'+req.user.id,
        'home_address', req.body.address,
        'home_lng', req.body.lng,
        'home_lat', req.body.lat
      );

      let json = await getDivisionsFromGoogle(req);

      if (json.error) {
        resp = { msg: json.error.message, error: 1 };
        wslog(req, 'dprofile', resp);
        return res.send(json.error.code);
      }

      // delete / re-add divisions
      await dbwrap('delAsync', 'user:'+req.user.id+':divisions');

      for (let div in json.divisions)
        await dbwrap('saddAsync', 'user:'+req.user.id+':divisions', div);

      // go through everyone this user has rated and see if they're still in the district
      var incumbents = await dbwrap('smembersAsync', 'user:'+req.user.id+':politician_ratings');
      var party = await getUserParty(req.user.id);
      for (let i = 0; i < incumbents.length; i++) {
        var rating;
        if (await userInPolDistrict(incumbents[i], req.user.id)) {
          rating = await dbwrap('zscoreAsync', 'politician:'+incumbents[i]+':rating_outsider:'+party, req.user.id);
          if (rating) {
            await dbwrap('zremAsync', 'politician:'+incumbents[i]+':rating_outsider:'+party, req.user.id);
            await dbwrap('zaddAsync', 'politician:'+incumbents[i]+':rating:'+party, rating, req.user.id);
          }
        } else {
          rating = await dbwrap('zscoreAsync', 'politician:'+incumbents[i]+':rating:'+party, req.user.id);
          if (rating) {
            await dbwrap('zremAsync', 'politician:'+incumbents[i]+':rating:'+party, req.user.id);
            await dbwrap('zaddAsync', 'politician:'+incumbents[i]+':rating_outsider:'+party, rating, req.user.id);
          }
        }
      }
    }
  } catch (e) {
    error = 1;
    console.log(e);
  }

  wslog(req, 'dprofile', {party: req.body.party, address: req.body.address, lng: req.body.lng, lat: req.body.lat, error: error});

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

async function userInPolDistrict(politician_id, user_id) {
  let div = await dbwrap('hgetAsync', 'politician:'+politician_id, 'divisionId');
  if (!div) return false;
  return await dbwrap('sismemberAsync', 'user:'+user_id+':divisions', div);
}

async function politician_rate(req, res) {
  var resp = {msg: 'Error'};
  var politician_id;
  var rating;
  var error;
  if (!req.user.id) return res.sendStatus(401);
  try {
    politician_id = req.body.politician_id;
    rating = req.body.rating;

    if (!politician_id || !req.user.id) {
      throw 'Invalid Input.';
    }

    // rating is optional
    if (rating) {
      // keep track of which politicians this users has rated so we can cleanup if they change party or district
      await dbwrap('saddAsync', 'user:'+req.user.id+':politician_ratings', politician_id);
      if (await userInPolDistrict(politician_id, req.user.id))
        await dbwrap('zaddAsync', 'politician:'+politician_id+':rating:'+await getUserParty(req.user.id), rating, req.user.id);
      else
        await dbwrap('zaddAsync', 'politician:'+politician_id+':rating_outsider:'+await getUserParty(req.user.id), rating, req.user.id);
    }

    resp = await getRatings(politician_id, req.user.id);

  } catch (e) {
    console.log(e);
    error = 1;
  }

  if (ovi_config.DEBUG)
    console.log(JSON.stringify(resp));

  wslog(req, 'politician_rate', {politician_id: politician_id, rating: rating, error: error});
  res.send(resp);
}

async function cimage(req, res) {
  let img = req.url.split("/").pop();
  let politician_id = img.split(".").shift();
  let photo_url = await dbwrap('hgetAsync', 'politician:'+politician_id, 'photo_url');

  if (!photo_url) return res.sendStatus(404);

  res.header('x-source-url', photo_url);
  req.url = '/'+ovi_config.img_cache_opt+'/'+photo_url;
  apiProxy.web(req, res, {target: ovi_config.img_cache_url});
}

async function getStateLegsFromOpenstates(req) {

  let lng = Number.parseFloat((req.body.lng?req.body.lng:req.query.lng));
  let lat = Number.parseFloat((req.body.lat?req.body.lat:req.query.lat));

  if (!lng || !lat) return [];

  var url = "https://openstates.org/api/v1/legislators/geo/?lat="+lat+"&long="+lng;

  try {
    const response = await fetch(url, {compress: true, headers: {'X-API-KEY': ovi_config.api_key_openstates}});
    const json = await response.json();
    return json;
  } catch (e) {
    console.log(e);
  }
  return {
    "error": {
      "code": 400,
      "message": "Unknown error."
    }
  };
}

async function getDivisionsFromGoogle(req) {

  let lng = Number.parseFloat((req.body.lng?req.body.lng:req.query.lng));
  let lat = Number.parseFloat((req.body.lat?req.body.lat:req.query.lat));
  let address = (req.body.address?req.body.address:req.query.address);

  if ((lng || lat) && (isNaN(lng) || isNaN(lat))) {
    return {
      "error": {
        "code": 400,
        "message": "Invalid input."
      }
    };
  }

  let url;
  let response;
  let json;
  let retry = false;

  do {

    // TODO: if retry and no lng/lat, call geocode API as a last ditch attempt

    url = "https://www.googleapis.com/civicinfo/v2/representatives"+
      "?key="+ovi_config.api_key_google+
      "&quotaUser="+getClientIP(req)+
      "&address="+((!retry && address)?address:lat+","+lng);

    if (ovi_config.DEBUG) console.log("Calling Google Civic API: "+url);

    try {
      response = await fetch(url, {compress: true});
      json = await response.json();
      if (json.error) {
        if (retry) {
          retry = false; // only retry once
          console.log("Google Civic API threw an error on lng/lat, no retry");
        } else {
          retry = true;
          console.log("Google Civic API threw an error on address, retrying with lng/lat");
          continue;
        }
      }
      return json;
    } catch (e) {
      console.log(e);
    }
  } while (retry);

  return {
    "error": {
      "code": 400,
      "message": "Unknown error."
    }
  };
}

async function whorepme(req, res) {
  var resp = {
    cd: [],
    sen: [],
    sldl: [],
    sldu: [],
    other: [],
  };

  const json = await getDivisionsFromGoogle(req);

  if (json.error) {
    resp = { msg: json.error.message, error: 1 };
    wslog(req, 'whorepme', resp);
    return res.send(json.error.code);
  }

  for (let div in json.divisions) {

    // if the last item of a division is a number, it's the district
    let district = div.split(":").pop();
    if (isNaN(district)) district = '';

    for (let numo in json.divisions[div].officeIndices) {
      let o = json.divisions[div].officeIndices[numo];
      let office = json.offices[o];

      var incumbents = [];
      for (let nump in office.officialIndices) {
        let p = office.officialIndices[nump];
        let official = json.officials[p];

        try {
          var last_name = official.name.split(" ").pop().toLowerCase();
          var first_name = official.name.split(" ").shift().toLowerCase();

          // calculate an ID based on division, last name, first name - no middle initial
          let politician_id = sha1(div+":"+last_name+":"+first_name);

          let address = ( official.address ? official.address[0] : {} );

          // convert "channel" types to static vars
          let facebook = '';
          let twitter = '';
          let googleplus = '';
          let youtube_key = 'youtube';
          let youtube_val = '';

          if (official.channels) {
            for (let ch in official.channels) {
              switch (official.channels[ch].type) {
                case 'Facebook': facebook = official.channels[ch].id; break;
                case 'Twitter': twitter = official.channels[ch].id; break;
                case 'GooglePlus': googleplus = official.channels[ch].id; break;
                case 'YouTube':
                  youtube_val = official.channels[ch].id;
                  if (official.channels[ch].id.match(/^UC/))
                    youtube_key = "youtube_id";
                  else
                    youtube_key = "youtube";
                  break;
              }
            }
          }

          let photo_url = '';
          if (official.photoUrl && ovi_config.img_cache_url && ovi_config.img_cache_opt) {
            photo_url = ovi_config.wsbase+'/images/'+politician_id+'.'+official.photoUrl.split(".").pop();
            // background task to have the image cache fetch it
            fetch(ovi_config.img_cache_url+'/'+ovi_config.img_cache_opt+'/'+official.photoUrl);
          }

          // TODO: hmset googlecivics:politician_id official
          // TODO: rather than transform google to offical directly, gather each OV "incumbent" from API cache hierarchy

          // transform google "offical" into OV "incumbent"
          let incumbent = {
            id: politician_id,
            divisionId: div,
            name: official.name,
            address: ( Object.keys(address).length ? address.line1+', '+address.city+', '+address.state+', '+address.zip : '' ),
            phone: (official.phones ? official.phones[0] : '' ),
            email: (official.emails ? official.emails[0] : '' ),
            party: ( official.party ? partyFull2Short(official.party) : '' ),
            state: json.normalizedInput.state,
            district: district,
            url: (official.urls ? official.urls[0] : '' ),
            photo_url: ( official.photoUrl ? official.photoUrl : '' ), // store the actual URL and not our cached
            facebook: facebook,
            twitter: twitter,
            googleplus: googleplus,
            [youtube_key]: youtube_val,
            office: office.name,
            last_updated: (new Date).getTime(),
          };

          cleanobj(incumbent);

          rc.hmset('politician:'+politician_id, incumbent);
          rc.sadd('division:'+div+':politicians', politician_id);

          incumbent.photo_url = photo_url; // pass the cached photo
          incumbent.ratings = await getRatings(politician_id, req.user.id);
          incumbents.push(incumbent);

        } catch(e) {
          console.log(e);
        }
      }

      let of = {
        key: div+':'+numo,
        name: office.name,
        state: json.normalizedInput.state,
        type: (office.levels ? office.levels.join(" ") : '') ,
        district: district,
        incumbents: incumbents,
        challengers: [],
      };

      if (office.levels) {
        if (office.levels.includes('country')) {
          if (office.name.match(/House of Representatives/)) {
            of.title = "U.S. House of Representatives";
            resp.cd.push(of);
          }
          else if (office.name.match(/Senate/)) {
            of.title = "U.S. Senate";
            resp.sen.push(of);
          }
          // else is other federal offices
        }
        else if (office.levels.includes('administrativeArea1')) {
          if (office.name.match(/Senate/)) {
            of.title = office.name.replace(/ District.*/, "");
            resp.sldu.push(of);
          }
          else if (office.name.match(/House/) || office.name.match(/Assembly/) || office.name.match(/Delegate/)) {
            of.title = office.name.replace(/ District.*/, "");
            resp.sldl.push(of);
          } else
            resp.other.push(of);
        }
        else
          resp.other.push(of);
      } else {
        resp.other.push(of);
      }

    }

  }

  // no state legs? try openstates
  if (resp.sldl.length == 0 || resp.sldu.length == 0) {
    const jleg = await getStateLegsFromOpenstates(req);

    for (let i in jleg) {
      try {
        let official = jleg[i];
        if (!official.active) continue;
      
        var last_name = official.last_name.toLowerCase();
        var first_name = official.first_name.toLowerCase();

        // TODO: official.boundary_id is NULL for Washington DC
        let politician_id = sha1(official.boundary_id+":"+last_name+":"+first_name);

        let photo_url = '';
        if (official.photo_url && ovi_config.img_cache_url && ovi_config.img_cache_opt)
          photo_url = ovi_config.wsbase+'/images/'+politician_id+'.'+official.photo_url.split(".").pop();

         var incumbent = {
          id: politician_id,
          divisionId: official.boundary_id,
          name: official.full_name,
          address: ( Object.keys(official.offices).length ? official.offices[0].address : '' ),
          phone: ( Object.keys(official.offices).length ? official.offices[0].phone : '' ),
          email: ( official.email ? official.email : '' ),
          party: ( official.party ? partyFull2Short(official.party) : '' ),
          state: official.state.toUpperCase(),
          district: official.district,
          url: (official.url ? official.url : '' ),
          photo_url: photo_url,
          ratings: await getRatings(politician_id, req.user.id),
        };

        rc.hmset('politician:'+politician_id,
          'last_updated', (new Date).getTime(),
          'divisionId', incumbent.divisionId,
          'name', incumbent.name,
          'address', incumbent.address,
          'phone', incumbent.phone,
          'email', incumbent.email,
          'party', incumbent.party,
          'url', incumbent.url,
          'photo_url', ( official.photo_url ? official.photo_url : '' ), // store the actual URL and not our cached
        );
        rc.sadd('division:'+incumbent.divisionId+':politicians', politician_id);

        let of = {
          key: official.boundary_id+':'+(i+10),
          name: incumbent.state+' State Legislative '+official.chamber+' House',
          state: incumbent.state,
          district: official.district,
          incumbents: [incumbent],
          challengers: [],
        };

        if (official.chamber == 'upper') resp.sldu.push(of);
        else resp.sldl.push(of);

      } catch(e) {
        console.log(e);
      }
    }
  }

  if (ovi_config.DEBUG) console.log(JSON.stringify(resp));

  wslog(req, 'whorepme', {lng: req.query.lng, lat: req.query.lat, address: req.body.address});
  res.send(resp);
}

async function search(req, res) {
  var resp = { results: [] };

  let str = req.query.str.replace(/(?:\r\n|\r|\n|\t|"|\\|)/g, '').toLowerCase()

  // alias broad search terms to narrow them down
  str = str.replace('state house', 'sldl');
  str = str.replace('state assembly', 'sldl');
  str = str.replace('state senate', 'sldu');

  // remove redundant terms
  str = str.replace('district', '');
  str = str.replace('legislative', '');
  str = str.replace('general', '');
  str = str.replace('party', '');

  // nice try...
  str = str.replace('*', '');

  let results = [];
  let items = str.split(" ");
  let done = false;

  if (items.length > 5) return res.status(400).send({msg: 'Too many search words.'});

  let idx = 0;
  for (let i in items) {
    if (done) continue;

    let item = items[i];
    if (!item) continue; // skip if empty

    // it's party time!
    let party = partyFull2Short(item);
    if (party && party != 'O') item = party.toLowerCase();

    let sr = '*'+item+'*';
    if (item.length < 4 && item != 'new') sr = item; // don't wildcard short search terms
    let keys = await dbwrap('keysAsync', 'zindex:'+sr);

    let cur_set = [];

    for (let k in keys) {
      let key = keys[k];
      let vals = await rc.smembersAsync(key);
       for (let v in vals) {
        let val = vals[v];

        // in the first run, put all keys in results
        if (idx == 0 && !results.includes(val)) results.push(val);
        else cur_set.push(val);
      }
    }

    // every run but the first, splice out the ID from results if it isn't in the current set
    if (idx > 0) {
      let trem = [];

      for (let r in results) {
        let cur = results[r];
        if (!cur_set.includes(cur)) {
          if (!trem.includes(cur)) trem.push(cur);
        }
      }

      for (let r in trem) {
        let rem = trem[r];
        results.splice(results.indexOf(rem), 1);
      }

      // down to zero results? bail early
      if (results.length == 0) done = true;

    }

    idx++;
  }

  // TODO: paginate
  if (results.length > 500) return res.status(400).send({msg: 'Too many results, please refine your search.'});

  for (let r in results) {
    let politician_id = results[r];
    // TODO: merge data from all sources for a full politician profile
    let pol = await rc.hgetallAsync('politician:'+politician_id);
    pol.id = politician_id;
    resp.results.push(pol)
  }

  wslog(req, 'search', {str: req.query.str});
  res.send(resp);
}

function partyFull2Short(partyFull) {
  switch (partyFull.toLowerCase()) {
    case 'republican': return 'R';
    case 'democrat': return 'D';
    case 'democratic': return 'D';
    case 'green': return 'G';
    case 'libertarian': return 'L';
    case 'unknown': return '';
    case 'independent': return 'I';
    default: return 'O';
  }
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
const apiProxy = httpProxy.createProxyServer();
app.disable('x-powered-by');
app.use(expressLogging(logger));
app.use(bodyParser.json());
app.use(cors());

// require ip_header if config for it is set
if (!ovi_config.DEBUG && ovi_config.ip_header) {
  app.use(function (req, res, next) {
    if (!req.header(ovi_config.ip_header)) {
      console.log('Connection without '+ovi_config.ip_header+' header');
      res.status(400).send();
    }
    else next();
  });
}

// add req.user if there's a valid JWT
app.use(function (req, res, next) {
  if (req.method == 'OPTIONS') return next(); // skip OPTIONS requests

  req.user = {};

  // uri whitelist
  if (req.url == '/poke' || req.url.match(/^\/images\//)) return next();

  if (ovi_config.require_auth && !req.header('authorization')) return res.status(401).send();

  try {
    let token = req.header('authorization').split(' ')[1];
    req.user = jwt.verify(token, ovi_config.jwt_secret);
  } catch (e) {
    if (ovi_config.require_auth) {
      console.log(e);
      return res.status(401).send();
    }
  }
  next();
});

// internal routes
app.get('/poke', poke);

// ws routes
if (ovi_config.img_cache_url && ovi_config.img_cache_opt)
  app.get('/images/*', cimage);
app.post('/api/v1/dinfo', dinfo);
app.post('/api/v1/dprofile', dprofile);
app.post('/api/v1/politician_rate', politician_rate);
app.post('/api/v1/whorepme', whorepme);
app.get('/api/v1/search', search);

// Launch the server
const server = app.listen(ovi_config.server_port, () => {
  const { address, port } = server.address();
  console.log('civic-broker express');
  console.log(`Listening at http://${address}:${port}`);
});


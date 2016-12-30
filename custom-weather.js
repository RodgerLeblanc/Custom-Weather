"use strict";

var useConfig = true;
var openWeatherMapApiKey = 'your_api_key_here';

var request = require('request');
var VectorWatch = require('vectorwatch-sdk');
var vectorWatch = new VectorWatch();
var logger = vectorWatch.logger;

vectorWatch.on('config', function(event, response) {
    // your stream was just dragged onto a watch face
    logger.info('on config');
    
    if (useConfig) {
        var city = response.createAutocomplete('City');
        city.setHint('Enter a city (ie: London, UK)');
        city.setAsYouType(1);

        var scale = response.createGridList('Scale');
        scale.setHint('Select temperature scale');
        scale.addOption('C');
        scale.addOption('F');
        
        var provider = response.createGridList('Provider');
        provider.setHint('Select weather provider');
        provider.addOption('Yahoo');
        provider.addOption('OpenWeatherMap');
    }

    response.send();
});

vectorWatch.on('options', function(event, response) {
    // dynamic options for a specific setting name was requested
    logger.info('on options');
    
    switch(event.req.body.settingName) {
        case 'City':
            var searchTerm = event.getSearchTerm();
    
            response.addOption(searchTerm);
            response.send();
            break;
    }
    
    return response;
});

vectorWatch.on('subscribe', function(event, response) {
    // your stream was added to a watch face
    logger.info('on subscribe');

    response.setValue('CellNinja');
	response.send();

    try {
        // Yahoo servers sometimes returns 503, which breaks the subscription. Call webhook to avoid this.
        callWebhook();
    } catch(err) {
        logger.error('Error on subscribe: ' + err.message);
    }
});

vectorWatch.on('unsubscribe', function(event, response) {
    // your stream was removed from a watch face
    logger.info('on unsubscribe');
    response.send();
});

vectorWatch.on('schedule', function(records) {
    logger.info('on schedule');

    records.forEach(function(record) {
        getWeatherFromRecord(record);
    });
});

vectorWatch.on('webhook', function(event, response, records) {
    logger.info('on webhook');
    
    records.forEach(function(record) {
        getWeatherFromRecord(record);
    });
    
    response.setContentType('text/plain');
    response.statusCode = 200;
    response.setContent('OK');
    response.send();
});

function callWebhook() {
    return new Promise(function (resolve, reject) {
        var url = 'https://endpoint.vector.watch/VectorCloud/rest/v1/stream/' + process.env.STREAM_UUID + '/webhook';
        logger.info('url: ' + url);

        request(url, function (error, httpResponse, body) {
            if (error) {
                reject('REST call error: ' + error.message + ' for ' + url);
                return;
            }

            if (httpResponse && httpResponse.statusCode != 200) {
                reject('REST call error: ' + httpResponse.statusCode + ' for ' + url);
                return;
            }

            resolve(body);
        });
    });
}

function getWeatherFromRecord(record) {
    var settings = getSettings(record.userSettings);
    try {
        getWeather(settings).then(function(body) {
            logger.info('body: ' + JSON.stringify(body));
            
            var streamText = getStreamText(settings, body);
            logger.info('streamText: ' + streamText);
                
            record.pushUpdate(streamText);
        }).catch(function(e) {
            logger.error('Error in on schedule first getWeather: ' + e);
            // Retry once again
            try {
                getWeather(settings).then(function(body) {
                    logger.info('body: ' + JSON.stringify(body));
            
                    var streamText = getStreamText(settings, body);
                    logger.info('streamText: ' + streamText);
                
                    record.pushUpdate(streamText);
                }).catch(function(e) {
                    logger.error('Error in on schedule second getWeather: ' + e);
                });
            } catch(err) {
                logger.error('Double error: ' + err.message);
            }
        });
    } catch(err) {
        logger.error('on push - malformed user setting: ' + err.message);
    }
}

function getWeather(settings) {
    return new Promise(function (resolve, reject) {
        var city = settings.City.name;
        var scale = settings.Scale.name;
        var provider = settings.Provider.name;
        
        var url = encodeURI((provider === 'Yahoo') ?
            'https://query.yahooapis.com/v1/public/yql?q=select item.condition ' +
        		'from weather.forecast where woeid in ' +
    	    	'(select woeid from geo.places(1) where ' +
    		    'text="' + city + '") and ' +
    		    'u=\'' + scale + '\'&format=json' 
    		                :
            'http://api.openweathermap.org/data/2.5/weather' +
        		'?q=' + city +
        		'&units=' + unitsToOWMUnits(scale) + 
		    	'&appid=' + openWeatherMapApiKey
		    );

        logger.info('url: ' + url);
        // https://query.yahooapis.com/v1/public/yql?q=select%20item.condition%20from%20weather.forecast%20where%20woeid%20in%20(select%20woeid%20from%20geo.places(1)%20where%20text=%22London,%20UK%22)%20and%20u=%27c%27&format=json
        // http://api.openweathermap.org/data/2.5/weather?q=London,%20UK&units=metric&appid=<your_api_key>
        
        request(url, function (error, httpResponse, body) {
            if (error) {
                reject('REST call error: ' + error.message + ' for ' + url);
                return;
            }

            if (httpResponse && httpResponse.statusCode != 200) {
                reject('REST call error: ' + httpResponse.statusCode + ' for ' + url);
                return;
            }

            try {
                body = JSON.parse(body);
                resolve(body);
            } catch(err) {
                reject('Malformed JSON response from ' + url + ': ' + err.message);
            }
        });
    });
}

function getSettings(settings) {
    if (!useConfig || (settings.City === undefined) || (settings.Scale === undefined) || (settings.Provider === undefined)) {
        settings = JSON.parse('{"City":{"name":"London, UK"},"Scale":{"name":"C"},"Provider":{"name":"OpenWeatherMap"}}');
    }
    return settings;
}

function unitsToOWMUnits(u) {
	return (u.toUpperCase() === 'F') ? "imperial" : "metric";
}

function getStreamText(settings, body) {
    var temp = Math.round((settings.Provider.name === 'Yahoo') ? 
            body.query.results.channel.item.condition.temp :
            body.main.temp);
            
    var icon = (settings.Provider.name === 'Yahoo') ? 
            body.query.results.channel.item.condition.code :
            body.weather[0].icon;

    var convertedIcon = (settings.Provider.name === 'Yahoo') ?
            vectorIconFromYahooIcon(icon) :
            vectorIconFromOWMIcon(icon);
    if (convertedIcon !== "") convertedIcon += " ";
    
    var scale = settings.Scale.name;
    
    return convertedIcon + temp + "°" + scale;
}

function vectorIconFromYahooIcon(code)  {
	switch(parseInt(code)) {
		case 0: return String.fromCharCode(0xe00a);
		case 1:
		case 2:
		case 3:
		case 4: return String.fromCharCode(0xe011);
		case 5:
		case 6: 
		case 7: return String.fromCharCode(0xe00e);
		case 8:
		case 9:
		case 10: return String.fromCharCode(0xe00d);
		case 11: 
		case 12: return String.fromCharCode(0xe00b);
		case 13: 
		case 14: 
		case 15: 
		case 16: return String.fromCharCode(0xe00f);
		case 17: return String.fromCharCode(0xe00d);
		case 18: return String.fromCharCode(0xe00e);
		case 19: return String.fromCharCode(0xe00a);
		case 20: 
		case 21: return String.fromCharCode(0xe009);
		case 22: 
		case 23: 
		case 24: return String.fromCharCode(0xe00a);
		case 25: return "";
		case 26:
		case 27:
		case 28: return String.fromCharCode(0xe008);
		case 29: 
		case 30: return String.fromCharCode(0xe006);
		case 31: return String.fromCharCode(0xe005);
		case 32: return String.fromCharCode(0xe004);
		case 33: return String.fromCharCode(0xe005);
		case 34: return String.fromCharCode(0xe004);
		case 35: return String.fromCharCode(0xe00e);
		case 36: return String.fromCharCode(0xe004);
		case 37: 
		case 38: 
		case 39: return String.fromCharCode(0xe011);
		case 40: return String.fromCharCode(0xe00b);
		case 41: 
		case 42: 
		case 43: return String.fromCharCode(0xe00f);
		case 44: return String.fromCharCode(0xe006);
		case 45: return String.fromCharCode(0xe011);
		case 46: return String.fromCharCode(0xe00f);
		case 47: return String.fromCharCode(0xe011);
		case 3200: return "";
		default: return "";
	}
} 

function vectorIconFromOWMIcon(code)  {
	switch(code) {
		case "01d": return String.fromCharCode(0xe004);
		case "01n": return String.fromCharCode(0xe004);
		case "02d": 
		case "02n": return String.fromCharCode(0xe004);
		case "03d":
		case "03n":
		case "04d":
		case "04n": return String.fromCharCode(0xe008);
		case "09d":
		case "09n":
		case "10d":
		case "10n": return String.fromCharCode(0xe00b);
		case "11d":
		case "11n": return String.fromCharCode(0xe011);
		case "13d":
		case "13n": return String.fromCharCode(0xe00f);
		case "50d":
		case "50n": return String.fromCharCode(0xe009);
		default: return "";
	}
} 
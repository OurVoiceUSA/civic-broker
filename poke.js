var http = require("http");

var options = {  
   host : 'localhost',
   port : '8080',
   path: '/poke',
   timeout : 4500,
   headers: {
     "cf-connecting-ip": "127.0.0.1"
   },
};

var request = http.request(options, (res) => {  
  if (res.statusCode == 200) {
    process.exit(0);
  }
  console.log('status code != 200');
  process.exit(1);
});

request.on('error', function(err) {  
    console.log('node.js http error');
    process.exit(1);
});

request.end();  

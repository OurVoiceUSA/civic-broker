## Introduction

Our Voice USA is a 501(c)(3) non-profit, non-partisian organization for civic education. We are writing tools to engage everyday citizens with the political process by providing easy access to civic information that's relevant to the individual.

## Features

This API provides civic data from various sources, such as the Google Civic API, OpenStates, and others.

## Development Setup

Start by configuring the `.env` file:

    cat << EOF > .env
    export REDIS_HOST=localhost
    export REDIS_PORT=6379
    export WSBASE=http://localhost:8080
    export API_KEY_GOOGLE=<YOUR KEY>
    export JWT_PUB_KEY=./rsa.pub
    export DEBUG=1
    EOF

Then, run the following steps:

* Install dependancies: `npm install`
* Copy the `rsa.pub` file from your `sm-oauth`
* Source in the configuration: `source .env`
* Start the application: `npm start`

Make sure you enable the Civic API on your google console in order for your `API_KEY_GOOGLE` to work here.

**NOTE:** At the time of this writing, the tool versions are as follows:

    $ npm -v
    6.4.1
    $ node -v
    v8.12.0

## Contributing

Thank you for your interest in contributing to us! To avoid potential legal headaches please sign our CLA (Contributors License Agreement). We handle this via pull request hooks on GitHub provided by https://cla-assistant.io/

## License

	Software License Agreement (AGPLv3+)
	
	Copyright (c) 2018, Our Voice USA. All rights reserved.

        This program is free software; you can redistribute it and/or
        modify it under the terms of the GNU Affero General Public License
        as published by the Free Software Foundation; either version 3
        of the License, or (at your option) any later version.

        This program is distributed in the hope that it will be useful,
        but WITHOUT ANY WARRANTY; without even the implied warranty of
        MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
        GNU Affero General Public License for more details.

        You should have received a copy of the GNU Affero General Public License
        along with this program; if not, write to the Free Software
        Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.


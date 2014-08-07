This is another fork of a fork of Sparkleshare-Dashboard.
This version will run on recent versions of nodejs (>= 0.10) and express (>=4.0).
Additionally, the UI was visually improved. It now looks a lot better on mobile phones.

It is now possible to edit single text files from the Dashboard, an API method
is also in place to be used from mobile clients.

Cheers,
- Stefan <stefan at lanpartei.de>


The following are the previous contents of the README.md file.

----

This is a fork of the NodeJS-driven Dashboard of the free Dropbox
alternative SparkleShare. The original repository was removed from
github from the author because of the "lack of interest" of the
community.

This version contains only a few little patches:

- better compatibility with older Git versions
- slightly improved rendering of contextual links in the folder view
- the ability to download (sub)folder contents as zip files

The patches are - just like the original sources - released under the
GNU Affero General Public License v3.

Please have a look at the `INSTALL.md` file for more detailed
information how to get the Dashboard up and running.

Have fun
- Thomas <me@thomaskeller.biz>


What follows are the original contents of the README.md file...

----

SparkleShare-Dashboard - A simple web interface to your SparkleShare server.


Manifesto
=========

SparkleShare-Dashboard provides users with a simple web interface to 
their SparkleShare server. It will provide a mechanism to authorize more 
devices; a service that handles announcements to other clients; a web API 
that mobile device clients are able to hook up to, and a way to see your
folders from your browser (if not encrypted).

The interface should be really easy to set up. 

Ofcourse, "easy" is a relative term, and people are usually considered 
geeky already when they have their own private (virtual) server.

However, many people know how to set up a basic website, or how to set up
a Wordpress blog, so they can help others who are less interested in
digital technology, but do care about privacy and freedom.

So that is the goal: simplicity. You should be able to set up 
SparkleShare-Dashboard in no more than 3 terminal commands. This includes 
logging into your server and download the package. From there, it needs 
to Just Work (TM). After that, you should be able to connect to it by 
providing the address (given) and a PIN, or a button that opens a file with 
a SparkleShare mimetype, so it take only one click to connect.


Design decisions
================

The server will be build on NodeJS. This is for several reasons: it doesn't 
have many dependencies (in fact it compiles on most default systems), it's 
easy to add javascript libraries, it's light, and it seems to be all the 
rage lately.


UI design
=========

Mockups are going on in hbons/SparkleShare-Design-Corner.
Feel free to fork and add your ideas.

=======
sparkleshare-dashboard

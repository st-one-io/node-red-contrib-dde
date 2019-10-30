# node-red-contrib-dde

A Node-RED node to exchange data with a DDE endpoint over the network.

This node was created by [Smart-Tech](https://netsmarttech.com) as part of the [ST-One](https://netsmarttech.com/page/st-one) project.

## Usage

Install and run the `NetDDEServer.exe` of [Chris Oldwood's](http://www.chrisoldwood.com/win32.htm) [DDE Network Bridge v2.0](http://www.chrisoldwood.com/win32/netdde/netdde20r.zip) on the target machine. Once running, just configure the DDE node with the target machine's IP Address, and all available Services/Topic/Items should be accessible from Node-RED for requesting, poking, executing, and advising.
A more detailed info about the message parameters and the node's configurations can be found on the "info" section of the node on the Node-RED's interface.

## Bugs and enhancements

Please share your ideas and experiences on the [Node-RED forum](https://discourse.nodered.org/), or open an issue on the [page of the project on GitHub](https://github.com/netsmarttech/node-red-contrib-dde)

## License

Copyright: (c) 2019, Smart-Tech, Guilherme Francescon Cittolin <guilherme.francescon@netsmarttech.com>

GNU General Public License v3.0+ (see [LICENSE](LICENSE) or https://www.gnu.org/licenses/gpl-3.0.txt)
